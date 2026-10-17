#!/usr/bin/env python3
import json
import os
import queue
import select
import socket
import subprocess
import sys
import time
import uuid
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

import build_events
import roadmap_sync
import roadmap_store
from build_dashboard import (
    StreamingEvent,
    StreamingEventBus,
    decode_ws_frame,
    encode_ws_frame,
    format_sse,
    get_event_bus,
    make_ws_accept,
)
from issue_lifecycle import (
    FACTORY_TASK_LABEL,
    IGNORED_LABELS,
    build_link_comment,
    build_result_comment,
    extract_assignee,
    get_webhook_dedupe_key,
    infer_phase_from_labels,
    is_webhook_duplicate,
    label_names,
    mark_issue_closed,
    record_sync_history,
    record_webhook_processed,
    task_matches_issue,
    unlink_and_pause_task,
)

PROJECT_ROOT = Path("/root/projects/software-factory").resolve()
LOG_DIR = PROJECT_ROOT / "logs"
LOG_DIR.mkdir(exist_ok=True)
LOG_FILE = LOG_DIR / "webhook.log"
DEDUPE_FILE = LOG_DIR / "webhook_dedupe.json"
ROADMAP_FILE = PROJECT_ROOT / "ROADMAP.json"
REPO = "moslembabaee/software-factory"

_processed_events: set[str] = set()


def log(msg: str):
    timestamp = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")
    line = f"[{timestamp}] [WEBHOOK] {msg}"
    print(line, flush=True)
    with open(LOG_FILE, "a", encoding="utf-8") as f:
        f.write(line + "\n")


def run_gh(cmd: list[str], runner=None, timeout: int = 30) -> tuple[int, str]:
    if runner is not None:
        try:
            res = runner(cmd)
            if isinstance(res, tuple):
                return res
            if hasattr(res, "returncode"):
                return res.returncode, getattr(res, "stdout", "")
            return 0, ""
        except Exception as e:
            return -1, str(e)
    try:
        res = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=timeout,
            cwd=str(PROJECT_ROOT),
        )
        return res.returncode, res.stdout or res.stderr
    except Exception as e:
        return -1, str(e)


def load_label_config(project_root: Path | None = None) -> dict:
    root = project_root or PROJECT_ROOT
    cfg_file = root / "maintainers.json"
    if cfg_file.exists():
        try:
            data = json.loads(cfg_file.read_text(encoding="utf-8"))
            return data.get("label_config", {})
        except Exception:
            pass
    return {}


def trigger_issue_bot():
    try:
        log("Triggering issue_bot to reconcile roadmap and GitHub issues...")
        subprocess.Popen([sys.executable, str(PROJECT_ROOT / "issue_bot.py")])
    except Exception as e:
        log(f"Error triggering issue_bot: {e}")


def log_issue_tasks(issue_num: int, message: str):
    if not ROADMAP_FILE.exists():
        return
    try:
        data = json.loads(ROADMAP_FILE.read_text(encoding="utf-8"))
        for task in data.get("tasks", []):
            if task_matches_issue(task, issue_num):
                build_events.emit(PROJECT_ROOT, task["id"], "webhook", message)
    except Exception:
        pass


def handle_issue_closed(issue_num: int, closed_at: str | None = None):
    if not isinstance(issue_num, int) or issue_num <= 0:
        return
    try:
        if ROADMAP_FILE.exists() and roadmap_store.update_roadmap(
            ROADMAP_FILE, lambda data: mark_issue_closed(data, issue_num, closed_at)
        ):
            log_issue_tasks(issue_num, f"GitHub issue #{issue_num} closed")
            roadmap_sync.sync_roadmap_to_github()
            get_event_bus(PROJECT_ROOT).publish_roadmap_sync(
                action="issue_closed",
                details={"issue_number": issue_num, "closed_at": closed_at},
            )
            log(f"Synchronized roadmap for closed Issue #{issue_num}")
    except Exception as e:
        log(f"Error synchronizing closed Issue #{issue_num}: {e}")

    try:
        res = subprocess.run(
            ["gh", "issue", "edit", str(issue_num), "--repo", REPO,
             "--remove-label", "in-progress,blocked"],
            capture_output=True, text=True, timeout=30,
        )
        if res.returncode == 0:
            log(f"Removed active labels from closed Issue #{issue_num}")
        else:
            log(f"Label cleanup failed for Issue #{issue_num}: {res.stderr.strip()}")
    except Exception as e:
        log(f"Error removing labels from Issue #{issue_num}: {e}")


def mark_task_approved(issue_num: int):
    approved_tasks: list[str] = []

    def approve(data):
        modified = False
        for task in data.get("tasks", []):
            if (task_matches_issue(task, issue_num) and not task.get("closed_at")
                    and task.get("status") in ("waiting_approval", "pending_approval", "pending", "failed", "escalated", "paused")):
                task["status"] = "approved"
                task["retry_count"] = 0
                task.pop("backoff_until", None)
                task.pop("backoff_seconds", None)
                task.pop("paused_at", None)
                task.pop("pause_reason", None)
                approved_tasks.append(task.get("id"))
                modified = True
        return modified

    try:
        if not ROADMAP_FILE.exists() or not roadmap_store.update_roadmap(ROADMAP_FILE, approve):
            return False
        log_issue_tasks(issue_num, f"GitHub issue #{issue_num} approved")
        roadmap_sync.sync_roadmap_to_github()

        for tid in approved_tasks:
            get_event_bus(PROJECT_ROOT).publish_task_transition(
                task_id=tid,
                status="approved",
                github_issue_number=issue_num,
            )
        get_event_bus(PROJECT_ROOT).publish_roadmap_sync(
            action="task_approved",
            details={"issue_number": issue_num, "task_ids": approved_tasks},
        )

        subprocess.run(
            ["gh", "issue", "edit", str(issue_num), "--repo", REPO,
             "--remove-label", "blocked"], capture_output=True, text=True, timeout=30,
        )
        return True
    except Exception as e:
        log(f"Error in mark_task_approved: {e}")
        return False


def handle_issue_labeled_factory_task(
    issue: dict, payload: dict | None = None, runner=None,
) -> bool:
    """Create or reconcile a roadmap task when a GitHub issue is labeled 'factory/task'."""
    num = issue.get("number")
    if not isinstance(num, int) or num <= 0:
        return False

    labels = label_names(issue)
    label_cfg = load_label_config()
    phase = infer_phase_from_labels(labels, label_cfg)
    assignee = extract_assignee(issue)
    assigned_agent = assignee if assignee in ("claude", "codex", "antigravity") else "claude"
    now_ts = datetime.now(timezone.utc).isoformat()

    created_task_id: str | None = None
    is_new = False

    def apply(data: dict) -> bool:
        nonlocal created_task_id, is_new
        tasks = data.setdefault("tasks", [])
        existing = next((t for t in tasks if task_matches_issue(t, num)), None)

        if existing:
            created_task_id = existing["id"]
            existing["github_issue_number"] = num
            existing.pop("unlinked", None)
            existing.pop("unlinked_from_issue", None)
            if existing.get("status") == "paused":
                existing["status"] = "approved"
                existing.pop("paused_at", None)
                existing.pop("pause_reason", None)
            existing["phase"] = phase
            existing["title"] = f"Issue #{num}: {issue.get('title', '')}"
            if assignee:
                existing["assignee"] = assignee
                if assignee in ("claude", "codex", "antigravity"):
                    existing["assigned_agent"] = assignee
            record = {
                "timestamp": now_ts,
                "github_event": "issues",
                "github_action": "labeled",
                "issue_id": issue.get("id"),
                "issue_number": num,
                "task_id": existing["id"],
                "action": "reconciled_link",
                "message": f"Reconciled task {existing['id']} from GitHub issue #{num} labeled '{FACTORY_TASK_LABEL}'",
            }
            record_sync_history(data, existing, record)
            return True
        else:
            is_new = True
            task_id = f"T-ISSUE-{num}"
            existing_ids = {t.get("id") for t in tasks}
            if task_id in existing_ids:
                task_id = f"T-ISSUE-{num}-1"
            created_task_id = task_id
            new_task = {
                "id": task_id,
                "phase": phase,
                "title": f"Issue #{num}: {issue.get('title', '')}",
                "description": (issue.get("body") or "") + f"\n\nReference: Closes #{num}",
                "assignee": assignee,
                "assigned_agent": assigned_agent,
                "status": "approved",
                "retry_count": 0,
                "verification_cmd": "cd /root/projects/software-factory && npm run typecheck && npm test",
                "github_issue_number": num,
                "created_at": now_ts,
            }
            record = {
                "timestamp": now_ts,
                "github_event": "issues",
                "github_action": "labeled",
                "issue_id": issue.get("id"),
                "issue_number": num,
                "task_id": task_id,
                "action": "task_created",
                "message": f"Created task {task_id} from GitHub issue #{num} labeled '{FACTORY_TASK_LABEL}' (phase: {phase}, assignee: {assignee or 'unassigned'})",
            }
            record_sync_history(data, new_task, record)
            tasks.insert(0, new_task)
            return True

    if not ROADMAP_FILE.exists() or not roadmap_store.update_roadmap(ROADMAP_FILE, apply):
        return False

    if created_task_id:
        msg = f"Linked GitHub issue #{num} to task {created_task_id}"
        build_events.emit(PROJECT_ROOT, created_task_id, "webhook", msg)
        roadmap_sync.sync_roadmap_to_github()

        get_event_bus(PROJECT_ROOT).publish_task_transition(
            task_id=created_task_id,
            status="approved",
            github_issue_number=num,
        )
        get_event_bus(PROJECT_ROOT).publish_roadmap_sync(
            action="task_created" if is_new else "reconciled_link",
            task_id=created_task_id,
            details={"issue_number": num, "phase": phase, "assignee": assignee},
        )

        log(msg)

        # Post bidirectional link comment to GitHub issue (stores task id in issue comment)
        if is_new:
            link_comment = build_link_comment(created_task_id, phase, assignee)
            run_gh(["gh", "issue", "comment", str(num), "--repo", REPO, "-b", link_comment], runner=runner)

    return True


def handle_issue_unlabeled_factory_task(
    issue: dict, payload: dict | None = None, runner=None,
) -> bool:
    """Unlink and pause task when 'factory/task' label is removed from an issue."""
    num = issue.get("number")
    if not isinstance(num, int) or num <= 0:
        return False

    affected_tasks: list[str] = []
    now_ts = datetime.now(timezone.utc).isoformat()

    def apply(data: dict) -> bool:
        modified = False
        for task in data.get("tasks", []):
            if task_matches_issue(task, num):
                task_id = task.get("id", "")
                affected_tasks.append(task_id)
                unlink_and_pause_task(task, num, f"Issue #{num} unlabeled '{FACTORY_TASK_LABEL}'")
                if data.get("current_task_id") == task_id:
                    data["current_task_id"] = None
                record = {
                    "timestamp": now_ts,
                    "github_event": "issues",
                    "github_action": "unlabeled",
                    "issue_id": issue.get("id"),
                    "issue_number": num,
                    "task_id": task_id,
                    "action": "task_unlinked_paused",
                    "message": f"Issue #{num} unlabeled '{FACTORY_TASK_LABEL}': unlinked and paused task {task_id}",
                }
                record_sync_history(data, task, record)
                modified = True
        return modified

    if not ROADMAP_FILE.exists() or not roadmap_store.update_roadmap(ROADMAP_FILE, apply):
        return False

    for tid in affected_tasks:
        msg = f"Issue #{num} unlabeled: unlinked and paused task {tid}"
        build_events.emit(PROJECT_ROOT, tid, "webhook", msg)
        get_event_bus(PROJECT_ROOT).publish_task_transition(
            task_id=tid,
            status="paused",
            github_issue_number=num,
        )
        get_event_bus(PROJECT_ROOT).publish_roadmap_sync(
            action="task_unlinked_paused",
            task_id=tid,
            details={"issue_number": num},
        )
        log(msg)

    roadmap_sync.sync_roadmap_to_github()
    return True


def handle_issue_edited(
    issue: dict, payload: dict | None = None, runner=None,
) -> bool:
    """Reconcile roadmap task when an issue is edited or assignees change."""
    num = issue.get("number")
    if not isinstance(num, int) or num <= 0:
        return False

    labels = label_names(issue)
    if FACTORY_TASK_LABEL not in labels:
        # If 'factory/task' is missing, ensure any existing link is unlinked & paused
        return handle_issue_unlabeled_factory_task(issue, payload, runner=runner)

    label_cfg = load_label_config()
    phase = infer_phase_from_labels(labels, label_cfg)
    assignee = extract_assignee(issue)
    now_ts = datetime.now(timezone.utc).isoformat()
    affected_tasks: list[str] = []

    def apply(data: dict) -> bool:
        tasks = data.get("tasks", [])
        matched = [t for t in tasks if task_matches_issue(t, num)]
        if not matched:
            return False

        for task in matched:
            task_id = task.get("id", "")
            affected_tasks.append(task_id)
            task["title"] = f"Issue #{num}: {issue.get('title', '')}"
            task["description"] = (issue.get("body") or "") + f"\n\nReference: Closes #{num}"
            task["phase"] = phase
            task["github_issue_number"] = num
            task.pop("unlinked", None)
            task.pop("unlinked_from_issue", None)
            if task.get("status") == "paused":
                task["status"] = "approved"
                task.pop("paused_at", None)
                task.pop("pause_reason", None)
            if assignee:
                task["assignee"] = assignee
                if assignee in ("claude", "codex", "antigravity"):
                    task["assigned_agent"] = assignee
            record = {
                "timestamp": now_ts,
                "github_event": "issues",
                "github_action": "edited",
                "issue_id": issue.get("id"),
                "issue_number": num,
                "task_id": task_id,
                "action": "task_reconciled",
                "message": f"Reconciled task {task_id} from edited GitHub issue #{num}",
            }
            record_sync_history(data, task, record)
        return True

    if not ROADMAP_FILE.exists():
        return False

    success = roadmap_store.update_roadmap(ROADMAP_FILE, apply)
    if not success and FACTORY_TASK_LABEL in labels:
        # If no task was matched but issue has factory/task, create it
        return handle_issue_labeled_factory_task(issue, payload, runner=runner)

    for tid in affected_tasks:
        msg = f"Issue #{num} edited: reconciled task {tid}"
        build_events.emit(PROJECT_ROOT, tid, "webhook", msg)
        get_event_bus(PROJECT_ROOT).publish_roadmap_sync(
            action="task_reconciled",
            task_id=tid,
            details={"issue_number": num, "phase": phase},
        )
        log(msg)

    roadmap_sync.sync_roadmap_to_github()
    return True


def handle_task_transition(
    task_id: str, new_status: str,
    commit_sha: str | None = None, pr_ref: str | None = None,
    runner=None,
) -> bool:
    """Close linked issues after completion; verified tasks still await PR merge."""
    if new_status not in ("done", "completed"):
        return False

    num: int | None = None
    task_snapshot: dict | None = None
    now_ts = datetime.now(timezone.utc).isoformat()

    def apply(data: dict) -> bool:
        nonlocal num, task_snapshot
        task = next((t for t in data.get("tasks", []) if t.get("id") == task_id), None)
        if not task or task.get("status") not in ("done", "completed"):
            return False
        num = task.get("github_issue_number")
        if not num:
            return False

        # Guard against posting duplicate closure notifications for the same transition
        if task.get(f"notified_{new_status}") or (new_status in ("done", "completed") and task.get("notified_completed")):
            return False

        task[f"notified_{new_status}"] = True
        if new_status in ("done", "completed"):
            task["notified_completed"] = True
            if not task.get("closed_at"):
                task["closed_at"] = now_ts

        if commit_sha and not task.get("commit_sha"):
            task["commit_sha"] = commit_sha
        if pr_ref and not task.get("pr_number"):
            task["pr_number"] = pr_ref

        record = {
            "timestamp": now_ts,
            "github_event": "task_transition",
            "github_action": new_status,
            "issue_number": num,
            "task_id": task_id,
            "action": "task_transition_closed_issue",
            "message": f"Task {task_id} transitioned to '{new_status}': summarized result and closed GitHub issue #{num}",
        }
        record_sync_history(data, task, record)
        task_snapshot = dict(task)
        return True

    if not ROADMAP_FILE.exists() or not roadmap_store.update_roadmap(ROADMAP_FILE, apply):
        return False

    if num and task_snapshot:
        comment = build_result_comment(task_snapshot, new_status)
        log(f"Task {task_id} transitioned to '{new_status}': posting comment and closing Issue #{num}...")
        run_gh(["gh", "issue", "comment", str(num), "--repo", REPO, "-b", comment], runner=runner)
        run_gh(["gh", "issue", "close", str(num), "--repo", REPO], runner=runner)
        run_gh(["gh", "issue", "edit", str(num), "--repo", REPO, "--remove-label", "in-progress,blocked"], runner=runner)

        build_events.emit(PROJECT_ROOT, task_id, "webhook", f"GitHub issue #{num} closed after task {new_status}")
        roadmap_sync.sync_roadmap_to_github()

        get_event_bus(PROJECT_ROOT).publish_task_transition(
            task_id=task_id,
            status=new_status,
            commit_sha=commit_sha,
            pr_ref=pr_ref,
            github_issue_number=num,
        )
        get_event_bus(PROJECT_ROOT).publish_roadmap_sync(
            action="task_transition_closed_issue",
            task_id=task_id,
            details={"status": new_status, "issue_number": num},
        )
        return True

    return False


def sync_tasks_to_issues(runner=None) -> int:
    """Scan roadmap and sync any unnotified completed tasks to their linked GitHub issues."""
    if not ROADMAP_FILE.exists():
        return 0
    try:
        data = json.loads(ROADMAP_FILE.read_text(encoding="utf-8"))
    except Exception:
        return 0

    count = 0
    for task in data.get("tasks", []):
        task_id = task.get("id")
        status = task.get("status")
        num = task.get("github_issue_number")
        if task_id and num and status in ("done", "completed"):
            if not task.get(f"notified_{status}") and not (status in ("done", "completed") and task.get("notified_completed")):
                if handle_task_transition(task_id, status, commit_sha=task.get("commit_sha"), runner=runner):
                    count += 1
    return count


class GitHubWebhookHandler(BaseHTTPRequestHandler):
    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, X-GitHub-Event, Authorization, Upgrade, Sec-WebSocket-Key, Sec-WebSocket-Version")
        self.end_headers()

    def do_POST(self):
        content_length = int(self.headers.get("Content-Length", 0))
        event_type = self.headers.get("X-GitHub-Event", "unknown")

        body = self.rfile.read(content_length).decode("utf-8")
        try:
            payload = json.loads(body)
        except Exception:
            payload = {}

        log(f"Received webhook event '{event_type}'")

        if self.path in ("/events/publish", "/api/events/publish", "/api/events"):
            event_type_name = payload.get("type", "custom")
            event_data = payload.get("data", payload)
            tid = payload.get("task_id")
            evt = get_event_bus(PROJECT_ROOT).publish(event_type_name, event_data, task_id=tid)
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(json.dumps({"ok": True, "event": evt.to_dict()}).encode("utf-8"))
            return

        if self.path in ("/task/transition", "/tasks/transition"):
            task_id = payload.get("task_id", "")
            status = payload.get("status", "")
            commit_sha = payload.get("commit_sha")
            pr_ref = payload.get("pr_ref") or payload.get("pr_number")
            get_event_bus(PROJECT_ROOT).publish_task_transition(
                task_id=task_id,
                status=status,
                commit_sha=commit_sha,
                pr_ref=pr_ref,
            )
            if status in ("done", "completed"):
                success = handle_task_transition(task_id, status, commit_sha=commit_sha, pr_ref=pr_ref)
            else:
                success = bool(task_id and status)
            self.send_response(200 if success else 400)
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(json.dumps({"ok": success}).encode("utf-8"))
            return

        if event_type == "ping":
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(b'{"status":"pong"}')
            return

        # Idempotency deduplication check for redelivered webhooks
        dedupe_key = get_webhook_dedupe_key(payload, dict(self.headers))
        if dedupe_key and is_webhook_duplicate(dedupe_key, DEDUPE_FILE, _processed_events):
            log(f"Duplicate webhook event '{dedupe_key}' ignored.")
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(b'{"ok":true,"duplicate":true}')
            return
        if dedupe_key:
            record_webhook_processed(dedupe_key, DEDUPE_FILE, _processed_events)

        if event_type == "issues":
            action = payload.get("action", "")
            issue = payload.get("issue", {})
            num = issue.get("number")
            title = issue.get("title", "")
            label_name = payload.get("label", {}).get("name", "").strip().lower()
            issue_labels = label_names(issue)
            if action == "labeled" and label_name:
                issue_labels.add(label_name)
            elif action == "unlabeled":
                issue_labels.discard(label_name)

            log(f"Issue #{num} ('{title}') action='{action}', label='{label_name}'")

            if action == "closed":
                log(f"Issue #{num} ('{title}') closed event! Synchronizing state...")
                handle_issue_closed(num, issue.get("closed_at"))
            elif issue.get("state") == "closed":
                pass
            elif action == "labeled" and label_name == FACTORY_TASK_LABEL:
                log(f"Issue #{num} received '{FACTORY_TASK_LABEL}' label! Creating/linking roadmap task...")
                handle_issue_labeled_factory_task(issue, payload)
            elif action == "unlabeled" and label_name == FACTORY_TASK_LABEL:
                log(f"Issue #{num} unlabeled '{FACTORY_TASK_LABEL}'! Unlinking and pausing task...")
                handle_issue_unlabeled_factory_task(issue, payload)
            elif action == "edited":
                log(f"Issue #{num} edited! Reconciling roadmap task...")
                handle_issue_edited(issue, payload)
            elif action in ("assigned", "unassigned"):
                log(f"Issue #{num} assignee updated! Reconciling roadmap task...")
                handle_issue_edited(issue, payload)
            elif action == "labeled" and label_name == "approved":
                if any(l in IGNORED_LABELS for l in issue_labels):
                    log(f"Issue #{num} ('{title}') has ignored label. Skipping app queue.")
                else:
                    log(f"Issue #{num} received 'approved' label! Authorizing task...")
                    mark_task_approved(num)
                    trigger_issue_bot()
            elif action in ("opened", "reopened"):
                if FACTORY_TASK_LABEL in issue_labels:
                    handle_issue_labeled_factory_task(issue, payload)
                elif any(l in IGNORED_LABELS for l in issue_labels):
                    log(f"Issue #{num} ('{title}') has ignored label. Skipping issue_bot trigger.")
                else:
                    trigger_issue_bot()

        elif event_type == "issue_comment":
            action = payload.get("action", "")
            comment = payload.get("comment", {})
            issue = payload.get("issue", {})
            num = issue.get("number")
            author = comment.get("user", {}).get("login", "").lower()
            comment_body = comment.get("body", "").lower()
            issue_labels = label_names(issue)

            log(f"Comment on Issue #{num} by @{author}: {comment_body[:80]}...")

            if action == "created" and author == "moslembabaee" and issue.get("state") != "closed":
                if any(kw in comment_body for kw in ("/approve", "approved", "lgtm")):
                    if any(l in IGNORED_LABELS for l in issue_labels):
                        log(f"Issue #{num} has ignored label. Skipping app queue despite comment.")
                    else:
                        log(f"Issue #{num} approved via comment by @{author}! Authorizing task...")
                        mark_task_approved(num)
                        trigger_issue_bot()

        elif event_type == "push":
            ref = payload.get("ref", "")
            commits = payload.get("commits", [])
            head_commit = payload.get("after") or (commits[-1].get("id") if commits else "unknown")
            log(f"Push event on ref '{ref}' (head: {head_commit[:8] if head_commit else 'unknown'}, {len(commits)} commits)")
            if ref in ("refs/heads/main", "refs/heads/master"):
                log("Target is production branch main. Triggering auto_deploy.sh in background...")
                try:
                    subprocess.Popen(["/bin/bash", str(PROJECT_ROOT / "auto_deploy.sh")])
                except Exception as e:
                    log(f"Error launching auto_deploy.sh: {e}")

        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(b'{"ok":true}')

    def do_GET(self):
        parsed = urlparse(self.path)
        path = parsed.path
        params = parse_qs(parsed.query)

        if path in ("/events", "/events/stream", "/stream", "/build/stream", "/ws", "/events/ws"):
            is_ws = (
                path in ("/ws", "/events/ws") or
                self.headers.get("Upgrade", "").lower() == "websocket"
            )
            if is_ws:
                self.handle_websocket(params)
            else:
                self.handle_sse(params)
            return

        if path in ("/health", "/ping"):
            bus = get_event_bus(PROJECT_ROOT)
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            payload = {
                "status": "ok",
                "subscribers": bus.subscriber_count,
                "timestamp": datetime.now(timezone.utc).isoformat(),
            }
            self.wfile.write(json.dumps(payload).encode("utf-8"))
            return

        self.send_response(200)
        self.send_header("Content-Type", "text/plain")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(b"Software Factory GitHub Webhook Listener is active\n")

    def handle_sse(self, params: dict):
        task_id = params.get("task_id", [None])[0]
        types_str = params.get("type", [None])[0]
        event_types = set(types_str.split(",")) if types_str else None
        task_ids = {task_id} if task_id else None

        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-cache, no-transform")
        self.send_header("Connection", "keep-alive")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "*")
        self.end_headers()

        bus = get_event_bus(PROJECT_ROOT)
        q = bus.subscribe(task_ids=task_ids, event_types=event_types)

        connected = StreamingEvent(
            type="connected",
            data={
                "status": "connected",
                "server": "software-factory-event-bus",
                "stream": "sse",
                "timestamp": datetime.now(timezone.utc).isoformat(),
            },
        )
        try:
            self.wfile.write(connected.to_sse().encode("utf-8"))
            self.wfile.flush()
        except Exception:
            bus.unsubscribe(q)
            return

        try:
            while not getattr(self.server, "_shutdown_requested", False):
                try:
                    event = q.get(timeout=2.0)
                    self.wfile.write(event.to_sse().encode("utf-8"))
                    self.wfile.flush()
                except queue.Empty:
                    self.wfile.write(b": ping\n\n")
                    self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError, OSError):
            pass
        finally:
            bus.unsubscribe(q)

    def handle_websocket(self, params: dict):
        key = self.headers.get("Sec-WebSocket-Key")
        if not key:
            self.send_response(400)
            self.send_header("Content-Type", "text/plain")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(b"Missing Sec-WebSocket-Key\n")
            return

        accept_key = make_ws_accept(key)
        self.send_response(101)
        self.send_header("Upgrade", "websocket")
        self.send_header("Connection", "Upgrade")
        self.send_header("Sec-WebSocket-Accept", accept_key)
        self.end_headers()
        self.wfile.flush()

        sock = self.connection
        sock.settimeout(0.5)

        task_id = params.get("task_id", [None])[0]
        types_str = params.get("type", [None])[0]
        event_types = set(types_str.split(",")) if types_str else None
        task_ids = {task_id} if task_id else None

        bus = get_event_bus(PROJECT_ROOT)
        q = bus.subscribe(task_ids=task_ids, event_types=event_types)

        init_payload = json.dumps({
            "id": str(uuid.uuid4()),
            "type": "connected",
            "status": "connected",
            "server": "software-factory-event-bus",
            "stream": "websocket",
            "timestamp": datetime.now(timezone.utc).isoformat(),
        })
        try:
            sock.sendall(encode_ws_frame(init_payload, opcode=0x01))
        except Exception:
            bus.unsubscribe(q)
            return

        try:
            last_ping = time.time()
            recv_buffer = bytearray()
            while not getattr(self.server, "_shutdown_requested", False):
                # Non-blocking check for incoming client frames
                readable, _, _ = select.select([sock], [], [], 0.05)
                if sock in readable:
                    try:
                        chunk = sock.recv(4096)
                        if not chunk:
                            break
                        recv_buffer.extend(chunk)
                        while True:
                            opcode, payload, rem = decode_ws_frame(bytes(recv_buffer))
                            if opcode is None:
                                break
                            recv_buffer = bytearray(rem)
                            if opcode == 0x08:  # Close
                                sock.sendall(encode_ws_frame(b"", opcode=0x08))
                                return
                            elif opcode == 0x09:  # Ping
                                sock.sendall(encode_ws_frame(payload or b"", opcode=0x0A))
                    except (socket.timeout, BlockingIOError, OSError):
                        pass

                try:
                    event = q.get(timeout=0.1)
                    sock.sendall(event.to_ws_frame())
                except queue.Empty:
                    pass

                if time.time() - last_ping > 15.0:
                    sock.sendall(encode_ws_frame(b"ping", opcode=0x09))
                    last_ping = time.time()
        except (BrokenPipeError, ConnectionResetError, OSError):
            pass
        finally:
            bus.unsubscribe(q)

    def log_message(self, format, *args):
        pass


def run():
    port = 9097
    server_address = ("127.0.0.1", port)
    bus = get_event_bus(PROJECT_ROOT)
    bus.start_file_watcher(PROJECT_ROOT)
    httpd = ThreadingHTTPServer(server_address, GitHubWebhookHandler)
    log(f"🚀 GitHub Webhook Listener running on 127.0.0.1:{port} with real-time SSE/WebSocket event streaming")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    httpd.server_close()
    bus.stop_file_watcher()
    log("Webhook Listener stopped.")


if __name__ == "__main__":
    run()
