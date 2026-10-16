"""Local patch directives, executed within the parent task's bounded retry chain.

Child tasks are roadmap records, not separately approved work. They remain pending
while the parent retries and are resolved by its verifier or terminal failure.
"""

from __future__ import annotations

from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path

from command_runner import run_cmd
from failure_analysis import FailureAnalysis, anonymize_secrets, synthesize_remediation_prompt

MAX_REMEDIATION_TASKS = 3
CONTROL_FILES = {"ROADMAP.json", "ROADMAP.md", "ROADMAP.json.lock", ".last_deployed_commit"}


def repository_path(value: str, root: Path) -> str | None:
    """Normalize exact repository paths; never correlate by basename alone."""
    try:
        path = Path(value.removeprefix("file://"))
        relative = (root / path).resolve().relative_to(root.resolve()).as_posix()
    except (OSError, ValueError):
        return None
    if relative in CONTROL_FILES or relative.startswith((".git/", "logs/", "node_modules/")):
        return None
    return relative


def correlate_changes(analysis: FailureAnalysis, root: Path) -> None:
    """Read staged, unstaged and new paths; attach a bounded, relevant HEAD diff.

    Missing Git metadata is harmless. No Git writes or provider calls are made.
    """
    analysis.diff_excerpt = ""
    changed: list[str] = []
    for args in (["git", "diff", "--name-only", "-z", "HEAD", "--"],
                 ["git", "ls-files", "--others", "--exclude-standard", "-z"]):
        code, output = run_cmd(args, 5, root)
        if code == 0:
            for value in output.split("\0"):
                path = repository_path(value, root) if value else None
                if path and path not in changed:
                    changed.append(path)
    analysis.changed_files = changed[:60]
    implicated = {repository_path(path, root) for path in analysis.implicated_files}
    analysis.related_files = [path for path in analysis.changed_files if path in implicated]
    targets = (analysis.related_files or analysis.changed_files)[:8]
    if targets:
        code, diff = run_cmd(["git", "--literal-pathspecs", "diff", "--no-ext-diff",
                              "--no-textconv", "--no-color", "--unified=3", "HEAD", "--", *targets], 5, root)
        if code == 0:
            analysis.diff_excerpt = anonymize_secrets(diff)[:4000]


def remediation_tasks(data: dict, parent_id: str) -> list[dict]:
    return [task for task in data["tasks"] if task.get("is_verification_remediation")
            and task.get("parent_task_id") == parent_id]


def synthesize_task(data: dict, parent: dict, analysis: FailureAnalysis) -> str | None:
    """Called within the verification transaction; identical evidence is idempotent."""
    evidence = {"command": analysis.command, "exit_code": analysis.exit_code,
                "diagnostics": [item.to_dict() for item in analysis.parsed_diagnostics],
                "files": analysis.related_files, "diff": analysis.diff_excerpt}
    if not analysis.parsed_diagnostics:
        evidence["raw_tail"] = analysis.raw_tail
    fingerprint = hashlib.sha256(json.dumps(evidence, sort_keys=True).encode()).hexdigest()
    children = remediation_tasks(data, parent["id"])
    existing = next((task for task in children if task["failure_fingerprint"] == fingerprint), None)
    if existing:
        if existing.get("closed_at"):
            return None
        existing["status"] = "pending"
        existing.pop("resolved_at", None)
        return existing["id"]
    if len(children) >= MAX_REMEDIATION_TASKS:
        return None
    # Do not inherit issue-shaped IDs: issue sync must not mistake these records
    # for independent work on (or closure of) the parent's GitHub issue.
    key = hashlib.sha256((parent["id"] + fingerprint).encode()).hexdigest()[:20]
    task_id = f"T-REPAIR-{key}"
    suffix = 1
    while any(task["id"] == task_id for task in data["tasks"]):
        task_id = f"T-REPAIR-{key}-{suffix}"
        suffix += 1
    files = (analysis.related_files or analysis.implicated_files or analysis.changed_files)[:8]
    child = {
        "id": task_id, "title": f"Repair verification failure in {', '.join(files) or parent['id']}"[:200],
        "phase": parent.get("phase", "Verification remediation"), "status": "pending",
        "assigned_agent": parent.get("assigned_agent", "claude"), "retry_count": 0,
        "description": synthesize_remediation_prompt(parent, analysis),
        "verification_cmd": parent["verification_cmd"], "parent_task_id": parent["id"],
        "is_verification_remediation": True, "execution_mode": "parent_retry",
        "failure_fingerprint": fingerprint, "target_files": files,
        "failure_analysis": analysis.to_dict(), "failure_summary": analysis.summary,
        "created_at": datetime.now(timezone.utc).isoformat(),
    }
    for key in ("tenant_id", "project_id"):
        if key in parent:
            child[key] = parent[key]
    data["tasks"].append(child)
    return task_id


def resolve_tasks(data: dict, parent: dict, status: str) -> None:
    for child in remediation_tasks(data, parent["id"]):
        if child.get("status") == "pending" and not child.get("closed_at"):
            child.update(status=status, resolved_at=datetime.now(timezone.utc).isoformat())
    parent.pop("remediation_task_id", None)
