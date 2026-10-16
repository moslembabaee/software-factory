#!/usr/bin/env python3
"""Stale-task recovery and backoff scheduler pass for Software Factory orchestrator."""

from __future__ import annotations

import argparse
from dataclasses import asdict, dataclass
from datetime import datetime, timedelta, timezone
import fcntl
import json
import math
import os
from pathlib import Path
import sys
from typing import Callable, Literal

import build_events
import roadmap_store
from command_runner import run_cmd

PROJECT_ROOT = Path(__file__).resolve().parent
REPO = "moslembabaee/software-factory"

DEFAULT_TTL_SECONDS = 1800.0  # 30 minutes
DEFAULT_TTLS: dict[str, float] = {
    "in_progress": DEFAULT_TTL_SECONDS,
    "waiting_approval": DEFAULT_TTL_SECONDS,
    "assigned": DEFAULT_TTL_SECONDS,
}
DEFAULT_MAX_RETRIES = 3
DEFAULT_BASE_BACKOFF_SECONDS = 300.0  # 5 minutes
MAX_BACKOFF_SECONDS = 14400.0  # 4 hours
MONITORED_STATUSES = ("in_progress", "waiting_approval", "assigned")
LOG_LIMIT = 4000


@dataclass(frozen=True)
class RecoveryAction:
    action: Literal["recover", "escalate"]
    task_id: str
    from_status: str
    to_status: str
    retry_count: int
    reason: str
    timestamp: str
    assigned_agent: str
    backoff_seconds: float | None = None
    backoff_until: str | None = None
    contacts: list[str] | None = None
    notice: str | None = None
    log_tail: str | None = None


def parse_timestamp(value: str | float | int | None) -> datetime | None:
    if value is None or value == "":
        return None
    if isinstance(value, (int, float)):
        return datetime.fromtimestamp(value, timezone.utc)
    if isinstance(value, str):
        val = value.replace("Z", "+00:00")
        try:
            dt = datetime.fromisoformat(val)
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=timezone.utc)
            return dt
        except ValueError:
            return None
    return None


def get_task_timestamp(task: dict, status: str) -> datetime | None:
    candidates: list[str] = []
    if status == "in_progress":
        candidates += ["started_at", "in_progress_at"]
    elif status == "assigned":
        candidates += ["assigned_at"]
    elif status == "waiting_approval":
        candidates += ["waiting_approval_at", "waiting_since"]

    candidates += [
        "status_updated_at",
        "recovered_at",
        "last_transition_at",
        "updated_at",
    ]

    for key in candidates:
        dt = parse_timestamp(task.get(key))
        if dt is not None:
            return dt

    attempts = task.get("attempts")
    if isinstance(attempts, list) and attempts:
        last = attempts[-1]
        if isinstance(last, dict):
            dt = parse_timestamp(last.get("timestamp"))
            if dt is not None:
                return dt

    verifications = task.get("verifications")
    if isinstance(verifications, list) and verifications:
        last = verifications[-1]
        if isinstance(last, dict):
            dt = parse_timestamp(last.get("timestamp"))
            if dt is not None:
                return dt

    dt = parse_timestamp(task.get("created_at"))
    if dt is not None:
        return dt

    return None


def is_task_stale(
    task: dict,
    status: str,
    ttl_seconds: float,
    now: datetime,
    file_mtime: float | None = None,
) -> tuple[bool, float, datetime | None]:
    """Return (is_stale, elapsed_seconds, state_timestamp)."""
    ts = get_task_timestamp(task, status)
    if ts is None:
        if file_mtime is not None:
            ts = datetime.fromtimestamp(file_mtime, timezone.utc)
        else:
            ts = now

    elapsed = (now - ts).total_seconds()
    is_stale = elapsed >= ttl_seconds if ttl_seconds > 0 else True
    return is_stale, elapsed, ts


def compute_backoff_seconds(
    retry_count: int,
    base_seconds: float = DEFAULT_BASE_BACKOFF_SECONDS,
    max_seconds: float = MAX_BACKOFF_SECONDS,
) -> float:
    # 2^retry_count * 5 min, capped at 4h
    backoff = (2 ** retry_count) * base_seconds
    return min(float(backoff), float(max_seconds))


def load_maintainers(project_root: Path) -> dict:
    maintainers_file = project_root / "maintainers.json"
    if maintainers_file.exists():
        try:
            return json.loads(maintainers_file.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            pass
    return {"authorized_approvers": ["moslembabaee"]}


def get_maintainer_contacts(maintainers: dict) -> list[str]:
    contacts = maintainers.get("contacts") or maintainers.get("authorized_approvers") or []
    if isinstance(contacts, list):
        return [str(c) for c in contacts]
    return ["moslembabaee"]


def get_last_log_tail(task: dict, project_root: Path, limit: int = LOG_LIMIT) -> str:
    if task.get("last_error"):
        return str(task["last_error"])[-limit:]

    attempts = task.get("attempts")
    if isinstance(attempts, list) and attempts:
        last = attempts[-1]
        if isinstance(last, dict) and last.get("log_tail"):
            return str(last["log_tail"])[-limit:]

    failures = task.get("verification_failures")
    if isinstance(failures, list) and failures:
        return str(failures[-1])[-limit:]

    verifications = task.get("verifications")
    if isinstance(verifications, list) and verifications:
        last = verifications[-1]
        if isinstance(last, dict) and last.get("log_tail"):
            return str(last["log_tail"])[-limit:]

    for log_name in ("orchestrator.log", "watchdog.log", "build.jsonl"):
        log_file = project_root / "logs" / log_name
        if log_file.exists():
            try:
                content = log_file.read_text(encoding="utf-8", errors="replace")
                if content:
                    return content[-limit:]
            except OSError:
                pass

    return "No prior log tail available."


def build_escalation_notice(
    task: dict,
    contacts: list[str],
    log_tail: str,
) -> str:
    task_id = task.get("id", "unknown")
    agent = task.get("assigned_agent", "unassigned")
    retry_count = task.get("retry_count", 0)

    contact_mentions = ", ".join(f"@{c.lstrip('@')}" for c in contacts) if contacts else "maintainers"

    history_parts = [f"- Current retry count: {retry_count}"]
    attempts = task.get("attempts")
    if isinstance(attempts, list) and attempts:
        history_parts.append("- Attempt history:")
        for idx, a in enumerate(attempts, 1):
            history_parts.append(
                f"  {idx}. Agent: {a.get('agent', '?')}, Exit: {a.get('exit_code')}, "
                f"Failure: {a.get('failure')}, Time: {a.get('timestamp')}"
            )

    recovery_history = task.get("recovery_history")
    if isinstance(recovery_history, list) and recovery_history:
        history_parts.append("- Recovery history:")
        for r in recovery_history:
            history_parts.append(
                f"  - {r.get('timestamp')}: from {r.get('from_status')} -> {r.get('to_status', 'waiting_approval')} "
                f"(retry {r.get('retry_count')}, reason: {r.get('reason')})"
            )

    retry_history_text = "\n".join(history_parts)

    notice = f"""⚠️ **Task Escalated: {task_id}**

Task `{task_id}` has exceeded maximum retries ({retry_count}) and is now escalated for manual intervention.
Attention maintainers: {contact_mentions}

- **Task ID:** `{task_id}`
- **Agent:** `{agent}`
- **Retry History:**
{retry_history_text}

- **Last Log Tail:**
```text
{log_tail}
```
"""
    return notice.strip()


def post_notice(
    task: dict,
    notice: str,
    project_root: Path,
    repo: str = REPO,
    runner: Callable = run_cmd,
) -> None:
    task["escalation_notice"] = notice
    build_events.emit(project_root, task["id"], "orchestrator", notice)

    issue_number = task.get("github_issue_number")
    if issue_number:
        try:
            runner(
                ["gh", "issue", "comment", str(issue_number), "--repo", repo, "-b", notice],
                15,
                project_root,
            )
        except Exception:
            pass


def emit_structured_log(
    log_file: Path,
    action: RecoveryAction,
) -> None:
    record = asdict(action)
    clean_record = {k: v for k, v in record.items() if v is not None}
    line = json.dumps(clean_record, sort_keys=True)
    try:
        log_file.parent.mkdir(parents=True, exist_ok=True)
        with log_file.open("a", encoding="utf-8") as f:
            fcntl.flock(f, fcntl.LOCK_EX)
            f.write(line + "\n")
    except OSError:
        pass


def recover_tasks(
    roadmap_file: Path | str,
    project_root: Path | str = PROJECT_ROOT,
    *,
    ttls: dict[str, float] | None = None,
    default_ttl: float = DEFAULT_TTL_SECONDS,
    max_retries: int = DEFAULT_MAX_RETRIES,
    base_backoff: float = DEFAULT_BASE_BACKOFF_SECONDS,
    max_backoff: float = MAX_BACKOFF_SECONDS,
    structured_log_file: Path | str | None = None,
    repo: str = REPO,
    now: datetime | None = None,
    task_id: str | None = None,
    dry_run: bool = False,
    runner: Callable = run_cmd,
) -> list[RecoveryAction]:
    """Scan roadmap for stale tasks, apply backoff and transition to waiting_approval or escalated.

    Idempotent and concurrency-safe: uses both recovery file lock and roadmap store lock.
    """
    roadmap_path = Path(roadmap_file).resolve()
    root_path = Path(project_root).resolve()
    log_path = Path(structured_log_file).resolve() if structured_log_file else (root_path / "logs" / "recovery.log")

    effective_ttls: dict[str, float] = {
        "in_progress": default_ttl,
        "waiting_approval": default_ttl,
        "assigned": default_ttl,
    }
    if ttls:
        effective_ttls.update(ttls)

    if not roadmap_path.exists():
        return []

    # File lock to prevent concurrent recovery processes from colliding
    lock_fd = None
    if not dry_run:
        lock_dir = root_path / "logs"
        lock_dir.mkdir(parents=True, exist_ok=True)
        lock_file = lock_dir / "recovery.lock"
        try:
            lock_fd = lock_file.open("a")
            fcntl.flock(lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except (BlockingIOError, OSError):
            if lock_fd is not None and not lock_fd.closed:
                lock_fd.close()
            return []

    try:
        current_time = now or datetime.now(timezone.utc)
        file_mtime = roadmap_path.stat().st_mtime
        maintainers = load_maintainers(root_path)
        contacts = get_maintainer_contacts(maintainers)

        if dry_run:
            try:
                data = json.loads(roadmap_path.read_text(encoding="utf-8"))
            except (json.JSONDecodeError, OSError):
                return []
            planned: list[RecoveryAction] = []
            for task in data.get("tasks", []):
                if task_id and task.get("id") != task_id:
                    continue
                status = task.get("status")
                if status not in MONITORED_STATUSES or task.get("closed_at"):
                    continue
                ttl = effective_ttls.get(status, default_ttl)
                stale, elapsed, _ = is_task_stale(task, status, ttl, current_time, file_mtime)
                if not stale:
                    continue
                curr_retries = task.get("retry_count", 0)
                new_retries = curr_retries + 1
                tail = get_last_log_tail(task, root_path)
                if new_retries >= max_retries:
                    reason = f"Stale task in '{status}' exceeded max retries ({max_retries}); would escalate"
                    notice = build_escalation_notice(task, contacts, tail)
                    action = RecoveryAction(
                        action="escalate",
                        task_id=task["id"],
                        from_status=status,
                        to_status="escalated",
                        retry_count=new_retries,
                        reason=reason,
                        timestamp=current_time.isoformat(),
                        assigned_agent=task.get("assigned_agent", "unassigned"),
                        contacts=contacts,
                        notice=notice,
                        log_tail=tail,
                    )
                else:
                    backoff = compute_backoff_seconds(new_retries, base_backoff, max_backoff)
                    backoff_until = (current_time + timedelta(seconds=backoff)).isoformat()
                    reason = f"Stale task in '{status}' after {elapsed:.0f}s (TTL {ttl:.0f}s); would retry {new_retries}/{max_retries}"
                    action = RecoveryAction(
                        action="recover",
                        task_id=task["id"],
                        from_status=status,
                        to_status="waiting_approval",
                        retry_count=new_retries,
                        reason=reason,
                        timestamp=current_time.isoformat(),
                        assigned_agent=task.get("assigned_agent", "unassigned"),
                        backoff_seconds=backoff,
                        backoff_until=backoff_until,
                    )
                planned.append(action)
            return planned

        executed_actions: list[RecoveryAction] = []

        def apply(data: dict) -> bool:
            nonlocal executed_actions
            executed_actions = []
            mutated = False

            for task in data.get("tasks", []):
                if task_id and task.get("id") != task_id:
                    continue
                status = task.get("status")
                if status not in MONITORED_STATUSES or task.get("closed_at"):
                    continue

                ttl = effective_ttls.get(status, default_ttl)
                stale, elapsed, _ = is_task_stale(task, status, ttl, current_time, file_mtime)
                if not stale:
                    continue

                mutated = True
                curr_retries = task.get("retry_count", 0)
                new_retries = curr_retries + 1
                tail = get_last_log_tail(task, root_path)

                if new_retries >= max_retries:
                    # Escalation
                    task["retry_count"] = new_retries
                    task["status"] = "escalated"
                    task["status_updated_at"] = current_time.isoformat()
                    task["escalated_at"] = current_time.isoformat()
                    reason = f"Stale task in '{status}' exceeded max retries ({max_retries}); escalated for manual intervention"
                    task["recovery_reason"] = reason
                    task["last_error"] = reason
                    task.setdefault("recovery_history", []).append({
                        "timestamp": current_time.isoformat(),
                        "from_status": status,
                        "to_status": "escalated",
                        "retry_count": new_retries,
                        "reason": reason,
                    })

                    notice = build_escalation_notice(task, contacts, tail)
                    post_notice(task, notice, root_path, repo, runner=runner)

                    if data.get("current_task_id") == task["id"]:
                        data["current_task_id"] = None

                    executed_actions.append(RecoveryAction(
                        action="escalate",
                        task_id=task["id"],
                        from_status=status,
                        to_status="escalated",
                        retry_count=new_retries,
                        reason=reason,
                        timestamp=current_time.isoformat(),
                        assigned_agent=task.get("assigned_agent", "unassigned"),
                        contacts=contacts,
                        notice=notice,
                        log_tail=tail,
                    ))
                else:
                    # Backoff & transition to waiting_approval
                    backoff = compute_backoff_seconds(new_retries, base_backoff, max_backoff)
                    backoff_until = (current_time + timedelta(seconds=backoff)).isoformat()
                    task["retry_count"] = new_retries
                    task["backoff_seconds"] = backoff
                    task["backoff_until"] = backoff_until
                    task["status"] = "waiting_approval"
                    task["status_updated_at"] = current_time.isoformat()
                    task["recovered_at"] = current_time.isoformat()
                    task["waiting_approval_at"] = current_time.isoformat()
                    reason = f"Stale task in '{status}' after {elapsed:.0f}s (TTL {ttl:.0f}s); retry {new_retries}/{max_retries}"
                    task["recovery_reason"] = reason
                    task["last_error"] = reason
                    task.setdefault("recovery_history", []).append({
                        "timestamp": current_time.isoformat(),
                        "from_status": status,
                        "to_status": "waiting_approval",
                        "retry_count": new_retries,
                        "backoff_seconds": backoff,
                        "backoff_until": backoff_until,
                        "reason": reason,
                    })

                    build_events.emit(root_path, task["id"], "orchestrator", reason)

                    if data.get("current_task_id") == task["id"]:
                        data["current_task_id"] = None

                    executed_actions.append(RecoveryAction(
                        action="recover",
                        task_id=task["id"],
                        from_status=status,
                        to_status="waiting_approval",
                        retry_count=new_retries,
                        reason=reason,
                        timestamp=current_time.isoformat(),
                        assigned_agent=task.get("assigned_agent", "unassigned"),
                        backoff_seconds=backoff,
                        backoff_until=backoff_until,
                    ))

            return mutated

        if roadmap_store.update_roadmap(roadmap_path, apply):
            for action in executed_actions:
                emit_structured_log(log_path, action)

        return executed_actions

    finally:
        if lock_fd is not None:
            try:
                fcntl.flock(lock_fd, fcntl.LOCK_UN)
            except OSError:
                pass
            try:
                lock_fd.close()
            except OSError:
                pass


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("task_id", nargs="?", default=None, help="Optional specific task ID to recover")
    parser.add_argument("--project-root", type=Path, default=PROJECT_ROOT, help="Project root directory")
    parser.add_argument("--roadmap-file", type=Path, default=None, help="Path to ROADMAP.json")
    parser.add_argument("--ttl", type=float, default=DEFAULT_TTL_SECONDS, help="Default TTL in seconds (default: 1800)")
    parser.add_argument("--ttl-in-progress", type=float, default=None, help="TTL for in_progress state in seconds")
    parser.add_argument("--ttl-waiting-approval", type=float, default=None, help="TTL for waiting_approval in seconds")
    parser.add_argument("--ttl-assigned", type=float, default=None, help="TTL for assigned state in seconds")
    parser.add_argument("--max-retries", type=int, default=DEFAULT_MAX_RETRIES, help="Max retries before escalation")
    parser.add_argument("--base-backoff", type=float, default=DEFAULT_BASE_BACKOFF_SECONDS, help="Base backoff in seconds")
    parser.add_argument("--max-backoff", type=float, default=MAX_BACKOFF_SECONDS, help="Max backoff in seconds")
    parser.add_argument("--structured-log", type=Path, default=None, help="Structured log file path")
    parser.add_argument("--repo", default=REPO, help="GitHub repository name")
    parser.add_argument("--dry-run", action="store_true", help="Scan and report without modifying roadmap store")
    args = parser.parse_args()

    project_root = args.project_root.resolve()
    roadmap_file = args.roadmap_file.resolve() if args.roadmap_file else (project_root / "ROADMAP.json")
    structured_log = args.structured_log.resolve() if args.structured_log else (project_root / "logs" / "recovery.log")

    ttls: dict[str, float] = {}
    if args.ttl_in_progress is not None:
        ttls["in_progress"] = args.ttl_in_progress
    if args.ttl_waiting_approval is not None:
        ttls["waiting_approval"] = args.ttl_waiting_approval
    if args.ttl_assigned is not None:
        ttls["assigned"] = args.ttl_assigned

    actions = recover_tasks(
        roadmap_file=roadmap_file,
        project_root=project_root,
        ttls=ttls if ttls else None,
        default_ttl=args.ttl,
        max_retries=args.max_retries,
        base_backoff=args.base_backoff,
        max_backoff=args.max_backoff,
        structured_log_file=structured_log,
        repo=args.repo,
        task_id=args.task_id,
        dry_run=args.dry_run,
    )

    if args.dry_run:
        print(f"Dry run: {len(actions)} task(s) would be affected.")
        for action in actions:
            print(json.dumps(asdict(action), indent=2))
    else:
        if actions:
            print(f"Recovery completed: {len(actions)} task(s) processed.")
        else:
            print("Recovery pass: No stale tasks found.")


if __name__ == "__main__":
    main()
