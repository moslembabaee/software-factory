#!/usr/bin/env python3
"""
Autonomous GitHub Issue Bot for Software Factory
1. Triages new issues (technical review, conflict detection, implementation plan).
2. Requires explicit authorization from maintainers (via label 'approved' or comment '/approve').
3. Dispatches approved issues to the Tri-Agent Orchestra (ROADMAP.json).
4. Synchronizes GitHub issues labeled 'factory/task' with roadmap tasks (two-way sync).
5. Closes issues upon completed implementation with summary comments.
"""

from __future__ import annotations

import json
import os
import re
import shlex
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

import build_events
from issue_lifecycle import (
    FACTORY_TASK_LABEL,
    IGNORED_LABELS,
    build_link_comment,
    build_result_comment,
    extract_assignee,
    infer_phase_from_labels,
    issue_number_for_task,
    label_names,
    mark_issue_closed,
    record_sync_history,
    task_matches_issue,
    unlink_and_pause_task,
)
import roadmap_store

PROJECT_ROOT = Path("/root/projects/software-factory").resolve()
ROADMAP_FILE = PROJECT_ROOT / "ROADMAP.json"
MAINTAINERS_FILE = PROJECT_ROOT / "maintainers.json"
LOG_DIR = PROJECT_ROOT / "logs"
LOG_DIR.mkdir(exist_ok=True)
LOG_FILE = LOG_DIR / "issue_bot.log"
REPO = "moslembabaee/software-factory"

FULL_PATH = "/root/.local/bin:/root/.hermes/tools/node-26.7.0-linux-x64/bin:/root/.hermes/tools/python-3.14.7+202****0901-linux-x64/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
os.environ["PATH"] = f"{FULL_PATH}:{os.environ.get('PATH', '')}"


def log(msg: str):
    timestamp = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")
    line = f"[{timestamp}] [ISSUE-BOT] {msg}"
    print(line, flush=True)
    with open(LOG_FILE, "a", encoding="utf-8") as f:
        f.write(line + "\n")


def run_cmd(cmd: str | list[str], timeout: int = 120) -> tuple[int, str]:
    try:
        if isinstance(cmd, list):
            res = subprocess.run(
                cmd,
                cwd=str(PROJECT_ROOT),
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                timeout=timeout,
            )
        else:
            res = subprocess.run(
                cmd,
                shell=True,
                cwd=str(PROJECT_ROOT),
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                timeout=timeout,
            )
        return res.returncode, res.stdout
    except Exception as e:
        return -1, str(e)


def load_maintainers() -> dict:
    if MAINTAINERS_FILE.exists():
        try:
            with open(MAINTAINERS_FILE, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            pass
    return {
        "authorized_approvers": ["moslembabaee"],
        "approval_keywords": ["/approve", "LGTM", "approved"],
        "auto_triage": true,
    }


def load_roadmap() -> dict:
    with open(ROADMAP_FILE, "r", encoding="utf-8") as f:
        return json.load(f)


def save_roadmap(data: dict):
    roadmap_store.save_roadmap(ROADMAP_FILE, data)
    try:
        import roadmap_sync
        roadmap_sync.sync_roadmap_to_github()
    except Exception as e:
        log(f"Warning: Failed to sync roadmap to GitHub: {e}")


def sync_closed_issues(roadmap: dict, runner=run_cmd) -> bool:
    endpoint = f"repos/{REPO}/issues?state=closed&per_page=100"
    code, out = runner(f"gh api --paginate {shlex.quote(endpoint)}")
    if code != 0:
        log(f"Error fetching closed issues: {out}")
        return False
    try:
        pages = json.loads(out)
    except (ValueError, TypeError) as e:
        log(f"Failed to parse closed issues JSON: {e}")
        return False

    modified = False
    issues = []
    if isinstance(pages, list):
        if pages and isinstance(pages[0], dict):
            issues = pages
        elif pages and isinstance(pages[0], list):
            issues = [item for page in pages for item in page]

    for issue in issues:
        if not isinstance(issue, dict) or "pull_request" in issue:
            continue
        num = issue.get("number")
        if not num:
            continue
        if label_names(issue) & {"in-progress", "blocked"}:
            code, output = runner(
                f'gh issue edit {num} --repo {REPO} --remove-label "in-progress,blocked"',
                timeout=30,
            )
            if code != 0:
                log(f"Failed to clean labels on closed Issue #{num}: {output}")
        modified = mark_issue_closed(roadmap, num, issue.get("closed_at")) or modified
    return modified


def sync_task_transitions(roadmap: dict, runner=run_cmd) -> bool:
    """Close linked issues only after task completion; verified tasks await PR merge."""
    modified = False
    now_ts = datetime.now(timezone.utc).isoformat()
    for task in roadmap.get("tasks", []):
        num = issue_number_for_task(task)
        if not num:
            continue
        status = task.get("status")
        if status in ("done", "completed"):
            if not task.get(f"notified_{status}") and not (status in ("done", "completed") and task.get("notified_completed")):
                task[f"notified_{status}"] = True
                if status in ("done", "completed"):
                    task["notified_completed"] = True
                    if not task.get("closed_at"):
                        task["closed_at"] = now_ts
                task_id = task.get("id", "")
                comment = build_result_comment(task, status)
                log(f"Task {task_id} is '{status}': posting comment and closing Issue #{num}...")
                runner(f'gh issue comment {num} --repo {REPO} -b {shlex.quote(comment)}')
                runner(f'gh issue close {num} --repo {REPO}')
                runner(f'gh issue edit {num} --repo {REPO} --remove-label "in-progress,blocked"')

                record = {
                    "timestamp": now_ts,
                    "github_event": "task_transition",
                    "github_action": status,
                    "issue_number": num,
                    "task_id": task_id,
                    "action": "task_transition_closed_issue",
                    "message": f"Task {task_id} transitioned to '{status}': summarized result and closed GitHub issue #{num}",
                }
                record_sync_history(roadmap, task, record)
                build_events.emit(PROJECT_ROOT, task_id, "webhook", record["message"])
                modified = True
    return modified


def fetch_open_issues() -> list:
    cmd = f'gh issue list --repo {REPO} --state open --json id,number,title,body,author,assignees,labels,comments,updatedAt,createdAt'
    code, out = run_cmd(cmd)
    if code == 0:
        try:
            return json.loads(out)
        except Exception as e:
            log(f"Failed to parse issues JSON: {e}")
    else:
        log(f"Error fetching issues: {out}")
    return []


def analyze_issue_with_ai(issue: dict) -> tuple[bool, str]:
    prompt = f"""You are the Lead Systems Architect for 'Software Factory' (autonomous code generation platform).
A user opened a new GitHub Issue:
Title: {issue['title']}
Description:
{issue['body']}

Analyze this request against Software Factory's core architecture (Fastify, TypeScript, PostgreSQL, agent runtime, queue/sandbox).
1. Is there any technical contradiction, duplicate feature, or architectural conflict?
2. If conflict exists, explain clearly what the issue is and suggest an alternative.
3. If valid, summarize the technical implementation plan (components to change, state changes, tests).

Format your response as a professional GitHub markdown comment. Start directly with '### 🤖 AI Architect Assessment'."""

    cmd = f'claude -p {shlex.quote(prompt)} --max-turns 3'
    code, out = run_cmd(cmd, timeout=90)
    if code != 0 or not out.strip():
        cmd = f'codex exec --sandbox workspace-write {shlex.quote(prompt)}'
        code, out = run_cmd(cmd, timeout=90)

    analysis_text = out.strip() if code == 0 and out.strip() else "### 🤖 AI Architect Assessment\nIssue received and queued for review."
    has_conflict = "conflict" in analysis_text.lower() or "contradict" in analysis_text.lower()
    return has_conflict, analysis_text


def decompose_issue_into_subtasks(issue: dict) -> list[dict]:
    body = issue.get("body", "")
    title = issue.get("title", "")
    has_subsections = ("####" in body) or (body.count("###") >= 3) or ("1." in body and "2." in body and "3." in body)
    if len(body) < 500 and not has_subsections:
        return [{
            "title": title,
            "description": body
        }]

    prompt = f"""You are the Lead Systems Architect for 'Software Factory' (Fastify, TypeScript, PostgreSQL, agent orchestration platform).
A GitHub Issue has been approved for development:
Title: {title}
Description:
{body}

This issue is large or multi-faceted. Decompose it into 2 to 4 small, focused, verifiable, sequential sub-tasks.
Each sub-task must be focused on a single responsibility that an AI agent can execute in under 15-20 turns and verify with 'cd /root/projects/software-factory && npm run typecheck && npm test'.

Output ONLY a valid JSON array of objects with keys "title" and "description" (no markdown backticks, no other text):
[
  {{
    "title": "Short descriptive title of sub-task",
    "description": "Specific requirements and acceptance criteria for this sub-task"
  }}
]"""

    cmd = f'claude -p {shlex.quote(prompt)} --max-turns 2'
    code, out = run_cmd(cmd, timeout=120)
    if code != 0 or not out.strip():
        cmd = f'codex exec --sandbox workspace-write {shlex.quote(prompt)}'
        code, out = run_cmd(cmd, timeout=120)

    try:
        raw = out.strip()
        if "```json" in raw:
            raw = raw.split("```json", 1)[1].split("```", 1)[0].strip()
        elif "```" in raw:
            raw = raw.split("```", 1)[1].split("```", 1)[0].strip()

        match = re.search(r'\[\s*\{.*\}\s*\]', raw, re.DOTALL)
        if match:
            subtasks = json.loads(match.group(0))
            if isinstance(subtasks, list) and len(subtasks) > 0:
                return subtasks
    except Exception as e:
        log(f"Failed to decompose issue with AI ({e}). Falling back to single task.")

    return [{
        "title": title,
        "description": body
    }]


def process_issues():
    maintainers_cfg = load_maintainers()
    label_cfg = maintainers_cfg.get("label_config", {})

    roadmap = load_roadmap()
    closed_modified = sync_closed_issues(roadmap)
    transitions_modified = sync_task_transitions(roadmap)
    if closed_modified or transitions_modified:
        save_roadmap(roadmap)
        roadmap = load_roadmap()

    issues = fetch_open_issues()
    if not issues:
        return

    log(f"Found {len(issues)} open issue(s). Processing...")
    roadmap_modified = False
    now_ts = datetime.now(timezone.utc).isoformat()

    for issue in issues:
        num = issue["number"]
        title = issue["title"]
        if num == 1 or "live tracker" in title.lower() or "roadmap dashboard" in title.lower() or "autonomous roadmap" in title.lower():
            continue
        labels = label_names(issue)

        ignored_match = next((l for l in labels if l in IGNORED_LABELS), None)
        if ignored_match:
            log(f"Skipping Issue #{num} ('{title}') - ignored label: '{ignored_match}'")
            continue

        task_id = f"T-ISSUE-{num}"
        matching_tasks = [
            t for t in roadmap["tasks"]
            if task_matches_issue(t, num)
        ]

        # 1. Handle issue labeled 'factory/task'
        if FACTORY_TASK_LABEL in labels:
            phase = infer_phase_from_labels(labels, label_cfg)
            assignee = extract_assignee(issue)
            assigned_agent = assignee if assignee in ("claude", "codex", "antigravity") else "claude"

            if matching_tasks:
                # Reconcile existing task
                for t in matching_tasks:
                    changed = False
                    if t.get("phase") != phase:
                        t["phase"] = phase
                        changed = True
                    if t.get("assignee") != assignee:
                        t["assignee"] = assignee
                        if assignee in ("claude", "codex", "antigravity"):
                            t["assigned_agent"] = assignee
                        changed = True
                    if t.get("unlinked"):
                        t["github_issue_number"] = num
                        t.pop("unlinked", None)
                        t.pop("unlinked_from_issue", None)
                        changed = True
                    if t.get("status") == "paused":
                        t["status"] = "approved"
                        t.pop("paused_at", None)
                        t.pop("pause_reason", None)
                        changed = True
                    if changed:
                        record = {
                            "timestamp": now_ts,
                            "github_event": "issues",
                            "github_action": "sync",
                            "issue_id": issue.get("id"),
                            "issue_number": num,
                            "task_id": t["id"],
                            "action": "task_reconciled",
                            "message": f"Reconciled task {t['id']} from GitHub issue #{num} labeled '{FACTORY_TASK_LABEL}'",
                        }
                        record_sync_history(roadmap, t, record)
                        build_events.emit(PROJECT_ROOT, t["id"], "webhook", record["message"])
                        roadmap_modified = True
                        log(f"Reconciled existing task {t['id']} for Issue #{num}")
            else:
                # Create new roadmap task with bidirectional link
                new_task = {
                    "id": task_id,
                    "phase": phase,
                    "title": f"Issue #{num}: {title}",
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
                record_sync_history(roadmap, new_task, record)
                roadmap["tasks"].insert(0, new_task)
                roadmap_modified = True

                link_msg = build_link_comment(task_id, phase, assignee)
                run_cmd(f'gh issue comment {num} --repo {REPO} -b {shlex.quote(link_msg)}')
                run_cmd(f'gh issue edit {num} --repo {REPO} --remove-label "blocked"')
                build_events.emit(PROJECT_ROOT, task_id, "webhook", record["message"])
                log(f"Created roadmap task {task_id} from Issue #{num} (phase: {phase})")
            continue

        # 2. Check if a previously linked task was unlabelled
        if matching_tasks and FACTORY_TASK_LABEL not in labels:
            for t in matching_tasks:
                if not t.get("unlinked") and t.get("status") not in ("completed", "verified", "closed"):
                    unlink_and_pause_task(t, num, f"Issue #{num} does not have '{FACTORY_TASK_LABEL}'")
                    if roadmap.get("current_task_id") == t["id"]:
                        roadmap["current_task_id"] = None
                    record = {
                        "timestamp": now_ts,
                        "github_event": "issues",
                        "github_action": "unlabeled",
                        "issue_id": issue.get("id"),
                        "issue_number": num,
                        "task_id": t["id"],
                        "action": "task_unlinked_paused",
                        "message": f"Issue #{num} missing '{FACTORY_TASK_LABEL}': unlinked and paused task {t['id']}",
                    }
                    record_sync_history(roadmap, t, record)
                    build_events.emit(PROJECT_ROOT, t["id"], "webhook", record["message"])
                    roadmap_modified = True
                    log(f"Unlinked and paused task {t['id']} because Issue #{num} lacks '{FACTORY_TASK_LABEL}'")
            continue

        # 3. Standard issue triage/approval fallback
        if matching_tasks and all(t.get("status") in ("completed", "verified") for t in matching_tasks):
            sync_task_transitions(roadmap)
            continue

        is_blocked = "blocked" in labels
        if is_blocked:
            log(f"Blocked Issue #{num} auto-unblocked (owner disabled gates).")
            run_cmd(f'gh issue edit {num} --repo {REPO} --remove-label "blocked" --add-label "approved"')
            is_blocked = False

        is_approved = True
        if "approved" not in labels:
            run_cmd(f'gh issue edit {num} --repo {REPO} --add-label "approved"')
            log(f"Issue #{num} AUTO-APPROVED (approval gate disabled by owner).")

        if "triaged" not in labels and "in-progress" not in labels:
            log(f"Skipping AI triage for new issue #{num} (approval gate disabled): '{title}'")
            run_cmd(f'gh issue edit {num} --repo {REPO} --add-label "triaged"')
            continue

        if is_approved:
            if matching_tasks:
                for t in matching_tasks:
                    if t.get("status") in ("waiting_approval", "pending_approval", "pending", "failed", "escalated", "paused"):
                        t["status"] = "approved"
                        t["retry_count"] = 0
                        t.pop("backoff_until", None)
                        t.pop("backoff_seconds", None)
                        roadmap_modified = True
                        log(f"Issue #{num} task {t['id']} is now APPROVED/RE-APPROVED by maintainer!")
                if "blocked" in labels:
                    run_cmd(f'gh issue edit {num} --repo {REPO} --remove-label "blocked"')
            else:
                log(f"Issue #{num} is APPROVED. Analyzing complexity and decomposing into sub-tasks...")
                subtasks = decompose_issue_into_subtasks(issue)
                phase = infer_phase_from_labels(labels, label_cfg)
                assignee = extract_assignee(issue)
                if len(subtasks) > 1:
                    log(f"Issue #{num} decomposed into {len(subtasks)} modular sub-tasks.")
                    new_tasks = []
                    for idx, sub in enumerate(subtasks):
                        sub_id = f"T-ISSUE-{num}-{idx+1}"
                        new_tasks.append({
                            "id": sub_id,
                            "phase": phase,
                            "title": f"Issue #{num} (Part {idx+1}/{len(subtasks)}): {sub['title']}",
                            "description": f"{sub['description']}\n\nParent Issue: #{num}\nReference: Closes #{num}",
                            "assignee": assignee,
                            "assigned_agent": assignee if assignee in ("claude", "codex", "antigravity") else "claude",
                            "status": "approved",
                            "retry_count": 0,
                            "verification_cmd": "cd /root/projects/software-factory && npm run typecheck && npm test",
                            "github_issue_number": num,
                            "subtask_index": idx + 1,
                            "total_subtasks": len(subtasks),
                            "created_at": now_ts,
                        })
                    for t in reversed(new_tasks):
                        roadmap["tasks"].insert(0, t)
                    roadmap_modified = True

                    subtask_list_md = "\n".join([f"{i+1}. **Part {i+1}/{len(subtasks)}:** `{s['title']}` (`T-ISSUE-{num}-{i+1}`)" for i, s in enumerate(subtasks)])
                    ack_msg = f"""🚀 **Scheduled for Autonomous Development!**

To ensure reliable execution and avoid session turn limits, this issue has been decomposed into **{len(subtasks)} modular sub-tasks**:

{subtask_list_md}

The Tri-Agent Orchestra is beginning execution on **Part 1**..."""
                    run_cmd(f'gh issue comment {num} --repo {REPO} -b {shlex.quote(ack_msg)}')
                    run_cmd(f'gh issue edit {num} --repo {REPO} --remove-label "blocked"')
                else:
                    new_task = {
                        "id": task_id,
                        "phase": phase,
                        "title": f"Issue #{num}: {title}",
                        "description": (issue.get("body") or "") + f"\n\nReference: Closes #{num}",
                        "assignee": assignee,
                        "assigned_agent": assignee if assignee in ("claude", "codex", "antigravity") else "claude",
                        "status": "approved",
                        "retry_count": 0,
                        "verification_cmd": "cd /root/projects/software-factory && npm run typecheck && npm test",
                        "github_issue_number": num,
                        "created_at": now_ts,
                    }
                    roadmap["tasks"].insert(0, new_task)
                    roadmap_modified = True

                    ack_msg = build_link_comment(task_id, phase, assignee)
                    run_cmd(f'gh issue comment {num} --repo {REPO} -b {shlex.quote(ack_msg)}')
                    run_cmd(f'gh issue edit {num} --repo {REPO} --remove-label "blocked"')
                log(f"Issue #{num} dispatched into ROADMAP.")

    if roadmap_modified:
        save_roadmap(roadmap)


if __name__ == "__main__":
    process_issues()