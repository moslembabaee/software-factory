"""Shared issue routing and close-state rules for the bot and webhook."""

from datetime import datetime, timezone

IGNORED_LABELS = frozenset({
    "infra", "infrastructure", "ops", "devops", "operations",
    "documentation", "docs", "manual", "wontfix", "invalid",
})


def label_names(issue: dict) -> set[str]:
    return {label["name"].strip().lower() for label in issue.get("labels", [])}


def issue_number_for_task(task: dict) -> int | None:
    if task.get("github_issue_number"):
        return int(task["github_issue_number"])
    task_id = task.get("id", "")
    if task_id.startswith("T-ISSUE-"):
        number = task_id[len("T-ISSUE-"):].split("-", 1)[0]
        if number.isdigit():
            return int(number)
    return None


def task_matches_issue(task: dict, number: int) -> bool:
    return issue_number_for_task(task) == number


def mark_issue_closed(roadmap: dict, number: int, closed_at: str | None = None) -> bool:
    """Closure is terminal for every linked task, including decomposed tasks."""
    modified = False
    timestamp = closed_at or datetime.now(timezone.utc).isoformat()
    for task in roadmap.get("tasks", []):
        if not task_matches_issue(task, number):
            continue
        if task.get("status") != "completed" or not task.get("closed_at"):
            task["status"] = "completed"
            if not task.get("completed_at"):
                task["completed_at"] = timestamp
            if not task.get("closed_at"):
                task["closed_at"] = timestamp
            modified = True
        if roadmap.get("current_task_id") == task.get("id"):
            roadmap["current_task_id"] = None
            modified = True
    return modified