"""Shared GitHub/roadmap reconciliation. Callers serialize writes with roadmap_store."""
from __future__ import annotations

import json
from datetime import datetime, timezone
from typing import Callable

GitHubRunner = Callable[[list[str]], tuple[int, str]]

from issue_lifecycle import (
    FACTORY_TASK_LABEL, build_link_comment, build_result_comment, extract_assignee,
    extract_task_id_from_issue, get_webhook_dedupe_key, infer_phase_from_labels,
    issue_number_for_task, label_names, record_sync_history, task_matches_issue,
    unlink_and_pause_task,
)


def timestamp() -> str:
    return datetime.now(timezone.utc).isoformat()


def event_record(issue: dict, payload: dict, action: str, task: dict) -> dict:
    return {
        "timestamp": timestamp(), "github_event": "issues",
        "github_action": payload.get("action", "poll"),
        "event_timestamp": issue.get("updated_at") or issue.get("updatedAt"),
        "event_key": get_webhook_dedupe_key({**payload, "issue": issue}),
        "delivery_id": payload.get("delivery_id"),
        "issue_id": issue.get("id"), "issue_number": issue["number"],
        "task_id": task["id"], "action": action,
        "message": f"GitHub issue #{issue['number']}: {action} ({task['id']})",
    }


def ensure_comment(number: int, marker: str, body: str, runner: GitHubRunner, repo: str) -> bool:
    # Recover from a crash between a successful GitHub write and local persistence.
    code, output = runner(["gh", "api", "--paginate", "--slurp",
                           f"repos/{repo}/issues/{number}/comments?per_page=100"])
    if code != 0:
        return False
    try:
        pages = json.loads(output)
        comments = [c for page in pages for c in (page if isinstance(page, list) else [page])]
        if any(marker in (c.get("body") or "") for c in comments if isinstance(c, dict)):
            return True
    except (ValueError, TypeError):
        return False
    if marker not in body:
        body += "\n\n" + marker
    return runner(["gh", "issue", "comment", str(number), "--repo", repo,
                   "--body", body])[0] == 0


def reconcile_issue(data: dict, issue: dict, payload: dict, config: dict,
                    runner: GitHubRunner, repo: str) -> tuple[bool, bool]:
    """Return (changed, delivered); retry pending comments without duplicating tasks."""
    number = issue.get("number")
    if not isinstance(number, int) or isinstance(number, bool) or number <= 0:
        return False, False
    labels = label_names(issue)
    label = (payload.get("label") or {}).get("name", "").strip().lower()
    action = payload.get("action", "poll")
    if action == "labeled":
        labels.add(label)
    elif action == "unlabeled":
        labels.discard(label)
    linked_id = extract_task_id_from_issue(issue)
    tasks = data.setdefault("tasks", [])
    matched = [t for t in tasks if task_matches_issue(t, number, linked_id, include_unlinked=True)]
    event_time = issue.get("updated_at") or issue.get("updatedAt")
    if event_time and any(t.get("github_updated_at", "") > event_time for t in matched):
        return False, True  # A delayed delivery must not undo a newer issue snapshot.
    changed = False
    if FACTORY_TASK_LABEL not in labels:
        for task in matched:
            # Legacy triage tasks do not opt into factory/task label ownership.
            if task.get("factory_issue_sync") and not task.get("unlinked"):
                unlink_and_pause_task(task, number, f"Issue #{number} no longer labeled '{FACTORY_TASK_LABEL}'")
                task["github_link_notified"] = False
                if event_time:
                    task["github_updated_at"] = event_time
                if data.get("current_task_id") == task["id"]:
                    data["current_task_id"] = None
                record_sync_history(data, task, event_record(issue, payload, "task_unlinked", task))
                changed = True
        return changed, True
    if issue.get("state", "open").lower() != "open":
        return False, True
    phase = infer_phase_from_labels(labels, config)
    assignee = extract_assignee(issue)
    if not matched:
        task_id = linked_id or f"T-ISSUE-{number}"
        if any(t["id"] == task_id for t in tasks):
            task_id = f"T-ISSUE-{number}"
            suffix = 1
            while any(t["id"] == task_id for t in tasks):
                task_id = f"T-ISSUE-{number}-{suffix}"
                suffix += 1
        task = {"id": task_id, "status": "approved", "retry_count": 0,
                "verification_cmd": "cd /root/projects/software-factory && npm run typecheck && npm test",
                "created_at": timestamp()}
        tasks.insert(0, task)
        matched = [task]
        created = True
    else:
        created = False
    delivered = True
    for task in matched:
        before = dict(task)
        was_unlinked = task.pop("unlinked", False)
        task.pop("unlinked_from_issue", None)
        task.update(github_issue_number=number, factory_issue_sync=True, phase=phase, assignee=assignee)
        # CLI polling uses GraphQL node IDs while webhook payloads use REST IDs.
        task.setdefault("github_issue_id", issue.get("id"))
        # Keep decomposed implementation scope intact when its parent is edited.
        if not task.get("total_subtasks"):
            task["title"] = f"Issue #{number}: {issue.get('title', '')}"
            task["description"] = (issue.get("body") or "") + f"\n\nReference: Closes #{number}"
        if assignee and assignee.lower() in ("claude", "codex", "antigravity"):
            task["assigned_agent"] = assignee.lower()
        else:
            task.setdefault("assigned_agent", "claude")
        if was_unlinked and task.get("status") == "paused":
            task["status"] = "approved"
            task.pop("paused_at", None)
            task.pop("pause_reason", None)
        if event_time:
            task["github_updated_at"] = event_time
        if created or task != before:
            record_sync_history(data, task, event_record(issue, payload, "task_created" if created else "task_reconciled", task))
            changed = True
        if not task.get("github_link_notified"):
            marker = f"<!-- factory-task-id: {task['id']} -->"
            if ensure_comment(number, marker, build_link_comment(task["id"], phase, assignee), runner, repo):
                task["github_link_notified"] = True
                record_sync_history(data, task, event_record(issue, payload, "issue_link_commented", task))
                changed = True
            else:
                delivered = False
    return changed, delivered


def result_ready(task: dict, close_on_verified: bool = False) -> bool:
    return task.get("status") in ("done", "completed") or (
        task.get("status") == "verified" and
        (close_on_verified or task.get("close_on_verified") or task.get("factory_issue_sync")))


def sync_results(data: dict, runner: GitHubRunner, repo: str, close_on_verified: bool = False,
                 task_id: str | None = None, new_status: str | None = None,
                 commit_sha: str | None = None, pr_ref: str | None = None) -> tuple[bool, int]:
    changed = False
    count = 0
    for task in data.get("tasks", []):
        if task_id and task.get("id") != task_id:
            continue
        status = task.get("status")
        if new_status and new_status != status:
            continue  # Notification endpoints cannot assert an unpersisted transition.
        number = issue_number_for_task(task)
        if not number or not result_ready(task, close_on_verified):
            continue
        if (task.get("github_result_synced") or task.get(f"notified_{status}") or
                (status in ("done", "completed") and task.get("notified_completed"))):
            continue
        if commit_sha and not task.get("commit_sha"):
            task["commit_sha"] = commit_sha
            changed = True
        if pr_ref and not task.get("pr_number"):
            task["pr_number"] = pr_ref
            changed = True
        siblings = [t for t in data["tasks"] if task_matches_issue(t, number)]
        all_done = all(result_ready(t, close_on_verified) for t in siblings)
        if not task.get("github_result_commented"):
            marker = f"<!-- factory-task-result: {task['id']} -->"
            comment = build_result_comment(task, status)
            if not all_done:
                comment = comment.replace("Closing linked GitHub issue.", "Waiting for remaining linked tasks before closing the issue.")
            if not ensure_comment(number, marker, comment, runner, repo):
                continue
            task["github_result_commented"] = True
            record_sync_history(data, task, {
                "timestamp": timestamp(), "github_event": "task_transition", "github_action": status,
                "issue_number": number, "task_id": task["id"], "action": "issue_result_commented",
            })
            changed = True
        if all_done and not any(t.get("github_issue_closed") for t in siblings):
            if runner(["gh", "issue", "close", str(number), "--repo", repo])[0] != 0:
                continue
            if runner(["gh", "issue", "edit", str(number), "--repo", repo,
                       "--remove-label", "in-progress,blocked"])[0] != 0:
                continue
            for sibling in siblings:
                sibling["github_issue_closed"] = True
                sibling.setdefault("closed_at", timestamp())
        task["github_result_synced"] = True
        task[f"notified_{status}"] = True
        if status in ("done", "completed"):
            task["notified_completed"] = True
        record_sync_history(data, task, {
            "timestamp": timestamp(), "github_event": "task_transition", "github_action": status,
            "issue_number": number, "task_id": task["id"],
            "action": "task_transition_closed_issue" if all_done else "subtask_transition",
            "message": f"Task {task['id']} {status}: {'closed' if all_done else 'updated'} issue #{number}",
        })
        changed = True
        count += 1
    return changed, count
