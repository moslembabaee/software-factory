#!/usr/bin/env python3
import json
import os
import subprocess
import sys
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

import build_events
import event_bus
import roadmap_sync
import roadmap_store
import issue_sync
from issue_lifecycle import (
    FACTORY_TASK_LABEL,
    IGNORED_LABELS,
    get_webhook_dedupe_key,
    label_names,
    mark_issue_closed,
    record_sync_history,
    task_matches_issue,
)

PROJECT_ROOT = Path("/root/projects/software-factory").resolve()
LOG_DIR = PROJECT_ROOT / "logs"
LOG_DIR.mkdir(exist_ok=True)
LOG_FILE = LOG_DIR / "webhook.log"
ROADMAP_FILE = PROJECT_ROOT / "ROADMAP.json"
REPO = "moslembabaee/software-factory"


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


def handle_issue_closed(issue_num: int, closed_at: str | None = None, runner=None):
    if not isinstance(issue_num, int) or issue_num <= 0:
        return
    try:
        if ROADMAP_FILE.exists() and roadmap_store.update_roadmap(
            ROADMAP_FILE, lambda data: mark_issue_closed(data, issue_num, closed_at)
        ):
            log_issue_tasks(issue_num, f"GitHub issue #{issue_num} closed")
            roadmap_sync.sync_roadmap_to_github()
            log(f"Synchronized roadmap for closed Issue #{issue_num}")
            try:
                event_bus.publish("roadmap_sync", {
                    "action": "issue_closed",
                    "issue_number": issue_num,
                    "timestamp": datetime.now(timezone.utc).isoformat(),
                })
            except Exception:
                pass
    except Exception as e:
        log(f"Error synchronizing closed Issue #{issue_num}: {e}")

    try:
        code, out = run_gh(
            ["gh", "issue", "edit", str(issue_num), "--repo", REPO,
             "--remove-label", "in-progress,blocked"],
            runner=runner, timeout=30,
        )
        if code == 0:
            log(f"Removed active labels from closed Issue #{issue_num}")
        else:
            log(f"Label cleanup failed for Issue #{issue_num}: {out.strip()}")
    except Exception as e:
        log(f"Error removing labels from Issue #{issue_num}: {e}")


def mark_task_approved(issue_num: int, runner=None):
    approved_task_ids = []
    now_ts = datetime.now(timezone.utc).isoformat()

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
                tid = task.get("id")
                approved_task_ids.append(tid)
                record = {
                    "timestamp": now_ts,
                    "github_event": "issues",
                    "github_action": "approved",
                    "issue_number": issue_num,
                    "task_id": tid,
                    "action": "task_approved",
                    "message": f"GitHub issue #{issue_num} approved: task {tid} marked approved",
                }
                record_sync_history(data, task, record)
                modified = True
        return modified

    try:
        if not ROADMAP_FILE.exists() or not roadmap_store.update_roadmap(ROADMAP_FILE, approve):
            return False
        log_issue_tasks(issue_num, f"GitHub issue #{issue_num} approved")
        for tid in approved_task_ids:
            try:
                event_bus.publish("task_transition", {
                    "task_id": tid,
                    "status": "approved",
                    "issue_number": issue_num,
                    "timestamp": datetime.now(timezone.utc).isoformat(),
                })
            except Exception:
                pass
        try:
            event_bus.publish("roadmap_sync", {
                "action": "tasks_approved",
                "issue_number": issue_num,
                "task_ids": approved_task_ids,
                "timestamp": datetime.now(timezone.utc).isoformat(),
            })
        except Exception:
            pass
        roadmap_sync.sync_roadmap_to_github()
        run_gh(
            ["gh", "issue", "edit", str(issue_num), "--repo", REPO,
             "--remove-label", "blocked"], runner=runner, timeout=30,
        )
        return True
    except Exception as e:
        log(f"Error in mark_task_approved: {e}")
        return False


def reconcile_github_issue(issue: dict, payload: dict | None = None, runner=None,
                           headers: dict | None = None) -> bool:
    """Persist receipts with reconciliation; failed GitHub writes remain retryable."""
    payload = {**(payload or {}), "issue": issue}
    payload["delivery_id"] = (headers or {}).get("X-GitHub-Delivery")
    key = get_webhook_dedupe_key(payload, headers)
    delivered = False
    records = []

    def apply(data):
        nonlocal delivered
        receipts = data.setdefault("github_sync_events", [])
        if key and key in receipts:
            delivered = True
            return False
        history_start = len(data.get("history", []))
        if payload.get("action") == "closed":
            changed = mark_issue_closed(data, issue["number"], issue.get("closed_at"), issue.get("id"))
            for record in data.get("history", [])[history_start:]:
                record.update(event_key=key, event_timestamp=issue.get("updated_at"),
                              delivery_id=payload.get("delivery_id"))
            delivered = run_gh(["gh", "issue", "edit", str(issue["number"]), "--repo", REPO,
                                "--remove-label", "in-progress,blocked"], runner=runner)[0] == 0
        else:
            changed, delivered = issue_sync.reconcile_issue(
                data, issue, payload, load_label_config(),
                lambda argv: run_gh(argv, runner=runner), REPO)
        records.extend(data.get("history", [])[history_start:])
        if delivered and key:
            receipts.append(key)
            del receipts[:-5000]
            changed = True
        return changed

    if not ROADMAP_FILE.exists():
        return False
    changed = roadmap_store.update_roadmap(ROADMAP_FILE, apply)
    if changed:
        roadmap_sync.sync_roadmap_to_github()
        for record in records:
            build_events.emit(PROJECT_ROOT, record["task_id"], "webhook", record.get("message", record["action"]))
            try:
                event_bus.publish("roadmap_sync", record)
            except Exception:
                pass
    return delivered


def handle_issue_labeled_factory_task(issue: dict, payload: dict | None = None, runner=None) -> bool:
    return reconcile_github_issue(issue, payload or {"action": "labeled", "label": {"name": FACTORY_TASK_LABEL}}, runner)


def handle_issue_unlabeled_factory_task(issue: dict, payload: dict | None = None, runner=None) -> bool:
    return reconcile_github_issue(issue, payload or {"action": "unlabeled", "label": {"name": FACTORY_TASK_LABEL}}, runner)


def handle_issue_edited(issue: dict, payload: dict | None = None, runner=None) -> bool:
    return reconcile_github_issue(issue, payload or {"action": "edited"}, runner)


def handle_task_transition(task_id: str, new_status: str,
                           commit_sha: str | None = None, pr_ref: str | None = None,
                           runner=None, close_on_verified: bool = False) -> bool:
    if not task_id or new_status not in ("verified", "done", "completed"):
        return False
    count = 0

    def apply(data):
        nonlocal count
        changed, count = issue_sync.sync_results(
            data, lambda argv: run_gh(argv, runner=runner), REPO, close_on_verified,
            task_id=task_id, new_status=new_status, commit_sha=commit_sha, pr_ref=pr_ref)
        return changed

    if ROADMAP_FILE.exists() and roadmap_store.update_roadmap(ROADMAP_FILE, apply):
        roadmap_sync.sync_roadmap_to_github()
        log(f"Task {task_id} '{new_status}': synchronized GitHub result")
    return count > 0


def sync_tasks_to_issues(runner=None, close_on_verified: bool = False) -> int:
    count = 0

    def apply(data):
        nonlocal count
        changed, count = issue_sync.sync_results(
            data, lambda argv: run_gh(argv, runner=runner), REPO, close_on_verified)
        return changed

    if ROADMAP_FILE.exists() and roadmap_store.update_roadmap(ROADMAP_FILE, apply):
        roadmap_sync.sync_roadmap_to_github()
    return count


class GitHubWebhookHandler(BaseHTTPRequestHandler):
    def do_POST(self):
        content_length = int(self.headers.get("Content-Length", 0))
        event_type = self.headers.get("X-GitHub-Event", "unknown")

        body = self.rfile.read(content_length).decode("utf-8")
        try:
            payload = json.loads(body)
        except Exception:
            payload = {}

        log(f"Received webhook event '{event_type}'")

        if self.path in ("/log", "/logs", "/events/log"):
            task_id = payload.get("task_id", "")
            source = payload.get("source", "agent")
            message = payload.get("message", "")
            if message:
                build_events.emit(PROJECT_ROOT, task_id, source, message)
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(b'{"ok":true}')
            return

        if self.path in ("/task/transition", "/tasks/transition"):
            task_id = payload.get("task_id", "")
            status = payload.get("status", "")
            commit_sha = payload.get("commit_sha")
            pr_ref = payload.get("pr_ref") or payload.get("pr_number")
            close_on_verified = payload.get("close_on_verified", False)
            success = handle_task_transition(
                task_id, status, commit_sha=commit_sha, pr_ref=pr_ref,
                close_on_verified=close_on_verified,
            )
            try:
                event_bus.publish("task_transition", {
                    "task_id": task_id,
                    "status": status,
                    "commit_sha": commit_sha,
                    "pr_ref": pr_ref,
                    "timestamp": datetime.now(timezone.utc).isoformat(),
                })
            except Exception:
                pass
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

            if (action == "closed" or (issue.get("state") != "closed" and
                    (FACTORY_TASK_LABEL in issue_labels or
                     (action == "unlabeled" and label_name == FACTORY_TASK_LABEL) or
                     action in ("edited", "assigned", "unassigned")))):
                try:
                    success = reconcile_github_issue(issue, payload, headers=dict(self.headers))
                except Exception as error:
                    log(f"Issue sync failed: {error}")
                    success = False
                self.send_response(200 if success else 503)
                self.send_header("Content-Type", "application/json")
                self.send_header("Access-Control-Allow-Origin", "*")
                self.end_headers()
                self.wfile.write(json.dumps({"ok": success}).encode("utf-8"))
                return

            if issue.get("state") == "closed":
                pass
            elif action == "labeled" and label_name == "approved":
                if any(l in IGNORED_LABELS for l in issue_labels):
                    log(f"Issue #{num} ('{title}') has ignored label. Skipping app queue.")
                else:
                    log(f"Issue #{num} received 'approved' label! Authorizing task...")
                    mark_task_approved(num)
                    trigger_issue_bot()
            elif action in ("opened", "reopened"):
                if any(l in IGNORED_LABELS for l in issue_labels):
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

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "*")
        self.end_headers()

    def do_GET(self):
        import urllib.parse
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        query = urllib.parse.parse_qs(parsed.query)

        is_websocket = (
            path in ("/ws", "/events/ws") or
            path.endswith("/ws") or
            self.headers.get("Upgrade", "").lower() == "websocket"
        )
        is_sse = (
            path in ("/events", "/stream", "/events/stream", "/api/events") or
            path.endswith("/events") or
            path.endswith("/stream") or
            "text/event-stream" in self.headers.get("Accept", "")
        )

        if is_websocket or is_sse:
            types_list = query.get("types", query.get("type", []))
            types_set = set()
            for t in types_list:
                for part in t.split(","):
                    part = part.strip()
                    if part:
                        types_set.add(part)
            if not types_set:
                types_set = None

            task_id = query.get("task_id", [None])[0]
            filter_fn = None
            if task_id:
                filter_fn = lambda e: (
                    e.get("data", {}).get("task_id") == task_id or
                    e.get("type") == "roadmap_sync"
                )

            subscriber = event_bus.subscribe_queue(event_types=types_set, filter_fn=filter_fn)

            if is_websocket:
                initial = [("connected", {"status": "connected", "protocol": "websocket"})]
                event_bus.handle_websocket_stream(self, subscriber, initial_events=initial)
                return
            else:
                initial = [("connected", {"status": "connected", "protocol": "sse"})]
                event_bus.handle_sse_stream(self, subscriber, initial_events=initial)
                return

        self.send_response(200)
        self.send_header("Content-Type", "text/plain")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(b"Software Factory GitHub Webhook Listener is active\n")

    def log_message(self, format, *args):
        pass


def run():
    try:
        event_bus.start_log_follower(PROJECT_ROOT)
    except Exception:
        pass
    port = 9097
    server_address = ("127.0.0.1", port)
    httpd = HTTPServer(server_address, GitHubWebhookHandler)
    log(f"🚀 GitHub Webhook Listener running on 127.0.0.1:{port}")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    httpd.server_close()
    log("Webhook Listener stopped.")


if __name__ == "__main__":
    run()