"""Trusted API bridge to the repository scheduler's atomic roadmap store."""
import hashlib
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

import build_events
import roadmap_store
import runtime_telemetry
from issue_lifecycle import issue_number_for_task

PENDING = {"pending", "pending_approval", "waiting_approval", "assigned", "failed", "escalated", "paused"}


def revision(task: dict) -> str:
    return hashlib.sha256(json.dumps(task, sort_keys=True).encode()).hexdigest()


def visible(task: dict, identity: dict, project_id: str) -> bool:
    # Legacy repository tasks have no trusted tenant binding and are never exposed.
    return task.get("tenant_id") == identity["tenantId"] and task.get("project_id") == project_id


def snapshot(path: Path, identity: dict, project_id: str) -> dict:
    data = json.loads(path.read_text(encoding="utf-8"))
    tasks = []
    sources = [task for task in data["tasks"] if visible(task, identity, project_id)]
    for task in sources:
        status = "waiting_approval" if task["status"] == "paused" else task["status"]
        tasks.append({"id": task["id"], "title": task["title"],
                      "description": task.get("description", ""), "phase": task.get("phase", ""),
                      "status": status, "assigned_agent": task.get("assigned_agent", ""),
                      "retry_count": task.get("retry_count", 0), "revision": revision(task),
                      "github_issue_number": issue_number_for_task(task),
                      "closed_at": task.get("closed_at"), "commit_sha": task.get("commit_sha"),
                      "budget_cap_usd": runtime_telemetry.task_telemetry(task)["budget"]["cap_usd"],
                      "telemetry": runtime_telemetry.task_telemetry(task),
                      "active_attempt": runtime_telemetry.active_attempt(task)})
    ids = {task["id"] for task in tasks}
    current = data.get("current_task_id")
    # Aggregate only after tenant/project filtering. Attempts never cross the API
    # boundary because their log tails may contain private provider output.
    metrics = runtime_telemetry.build_metrics([
        {**view, "attempts": source.get("attempts", [])}
        for view, source in zip(tasks, sources)
    ])
    return {"tasks": tasks, "current_task_id": current if current in ids else None,
            "logs": build_events.tail(path.parent, ids), "metrics": metrics}


def set_budget(path: Path, identity: dict, project_id: str, task_id: str, expected: str, cap) -> dict:
    if cap is not None and runtime_telemetry.nonnegative(cap, None) is None:
        return {"error": 400}
    result = {}

    def update(data):
        task = next((task for task in data["tasks"] if task["id"] == task_id
                     and visible(task, identity, project_id)), None)
        if task is None:
            result["error"] = 404
            return False
        if task.get("closed_at") or revision(task) != expected:
            result["error"] = 409
            return False
        task["budget_cap_usd"] = cap
        if "telemetry" in task:
            task["telemetry"] = runtime_telemetry.task_telemetry(task)
        return True

    if roadmap_store.update_roadmap(path, update):
        build_events.emit(path.parent, task_id, "dashboard", "Task budget updated")
    return result


def approve(path: Path, identity: dict, project_id: str, task_id: str, expected: str) -> dict:
    result = {}

    def update(data):
        task = next((task for task in data["tasks"] if task["id"] == task_id
                     and visible(task, identity, project_id)), None)
        if task is None:
            result["error"] = 404
            return False
        approval = task.get("build_approval", {})
        if approval.get("revision") == expected and approval.get("actor_id") == identity["actorId"]:
            return False  # Retry of a successful decision, even after dispatch/closure.
        if task.get("closed_at") or task["status"] not in PENDING or revision(task) != expected:
            result["error"] = 409
            return False
        task["status"] = "approved"
        task["retry_count"] = 0
        task.pop("backoff_until", None)
        task.pop("backoff_seconds", None)
        task["build_approval"] = {"revision": expected, "actor_id": identity["actorId"],
                                  "approved_at": datetime.now(timezone.utc).isoformat()}
        return True

    changed = roadmap_store.update_roadmap(path, update)
    if changed:
        build_events.emit(path.parent, task_id, "dashboard", "Task approved for dispatch")
    return result


if __name__ == "__main__":
    path = Path(sys.argv[1])
    request = json.load(sys.stdin)
    result = {}
    if request["operation"] == "approve":
        result = approve(path, request["identity"], request["projectId"], request["taskId"], request["revision"])
    if request["operation"] == "budget":
        result = set_budget(path, request["identity"], request["projectId"], request["taskId"],
                            request["revision"], request["budget_cap_usd"])
    if "error" not in result:
        result = snapshot(path, request["identity"], request["projectId"])
    print(json.dumps(result))
