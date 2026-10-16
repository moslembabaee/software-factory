#!/usr/bin/env python3
"""Execute trusted roadmap verification commands and persist their results."""

from __future__ import annotations

import argparse
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
import fcntl
import json
import math
from pathlib import Path
import signal
from typing import Callable, Literal

from command_runner import run_cmd_split
from failure_analysis import FailureAnalysis, analyze_failure
import roadmap_store
import verification_remediation as remediation

PROJECT_ROOT = Path(__file__).resolve().parent
LOG_LIMIT = 4000
ACTIVE_STATUSES = {"in_progress", "ready_for_verification"}


@dataclass(frozen=True)
class VerificationResult:
    outcome: Literal["verified", "failed", "skipped", "cancelled", "busy", "dry_run"]
    exit_code: int | None = None
    log_tail: str = ""
    note: str = ""
    failure_analysis: dict | None = None


def missing_command(task: dict) -> bool:
    command = task.get("verification_cmd")
    return not isinstance(command, str) or not command.strip()


def skip_recorded(task: dict) -> bool:
    records = task.get("verifications", [])
    return bool(missing_command(task) and records and records[-1].get("skipped"))


def verify_task(
    task_id: str, project_root: Path = PROJECT_ROOT, *, timeout: float = 300,
    dry_run: bool = False,
    runner: Callable[[str, float, Path], tuple[int, str] | tuple[int, str, str]] = run_cmd_split,
) -> VerificationResult:
    """Verify one active task, merging only verification fields into its live record.

    The repository verification lock prevents duplicate executions by the CLI and
    worker. The roadmap lock is held only for the final update, so other roadmap
    writers remain free to cancel tasks or update unrelated fields while we run.
    """
    if not math.isfinite(timeout) or timeout <= 0:
        raise ValueError("Verification timeout must be finite and positive")
    project_root = Path(project_root).resolve()
    path = project_root / "ROADMAP.json"

    def load_task() -> dict:
        data = json.loads(path.read_text(encoding="utf-8"))
        task = next((t for t in data["tasks"] if t["id"] == task_id), None)
        if task is None:
            raise ValueError(f"Unknown task: {task_id}")
        return task

    initial = load_task()
    if dry_run:
        note = ("Verification skipped: no verification_cmd configured" if missing_command(initial)
                else f"Would run in {project_root} (timeout {timeout}s): {initial['verification_cmd']}")
        return VerificationResult("dry_run", note=note)

    directory = project_root / "logs"
    directory.mkdir(exist_ok=True)
    with (directory / "verification.lock").open("a") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return VerificationResult("busy", note="Another repository verification is running")
        initial = load_task()
        if initial.get("closed_at") or initial.get("status") not in ACTIVE_STATUSES:
            return VerificationResult("cancelled", note="Task is no longer awaiting verification")

        skipped = missing_command(initial)
        if skipped and skip_recorded(initial):
            return VerificationResult("skipped", note="Verification skipped: no verification_cmd configured")
        analysis = None
        if skipped:
            code, tail = None, ""
            note = "Verification skipped: no verification_cmd configured"
        else:
            run_res = runner(initial["verification_cmd"], timeout, project_root)
            if len(run_res) == 3:
                code, stdout_out, stderr_out = run_res
                output = f"{stdout_out}\n{stderr_out}".strip() if stdout_out and stderr_out else (stdout_out or stderr_out)
                tail, note = output[-LOG_LIMIT:], ""
                if code != 0:
                    analysis = analyze_failure(code, stdout_out, initial["verification_cmd"], stderr=stderr_out)
            else:
                code, output = run_res
                tail, note = output[-LOG_LIMIT:], ""
                if code != 0:
                    analysis = analyze_failure(code, output, initial["verification_cmd"])
            if analysis is not None:
                remediation.correlate_changes(analysis, project_root)
                analysis = analysis.to_dict()
        record = {"timestamp": datetime.now(timezone.utc).isoformat(),
                  "exit_code": code, "log_tail": tail,
                  "command": initial.get("verification_cmd"), "skipped": skipped}
        if note:
            record["note"] = note
        if analysis is not None:
            record["failure_analysis"] = analysis
            record["failure_summary"] = analysis["summary"]

        def apply(data: dict) -> bool:
            task = next((t for t in data["tasks"] if t["id"] == task_id), None)
            if (not task or task.get("closed_at") or
                    any(task.get(key) != initial.get(key) for key in
                        ("status", "verification_cmd", "build_approval", "started_at"))):
                return False
            task.setdefault("verifications", []).append(record)
            if not skipped:
                task["status"] = "verified" if code == 0 else "in_progress"
                if code != 0:
                    task["retry_count"] = task.get("retry_count", 0) + 1
                    task.setdefault("verification_failures", []).append(tail)
                    task["last_error"] = f"Verification failed ({code})\n{tail}"
                    task["failure_analysis"] = analysis
                    task["failure_summary"] = analysis["summary"]
                    child_id = remediation.synthesize_task(
                        data, task, FailureAnalysis.from_dict(analysis))
                    if child_id:
                        task["remediation_task_id"] = child_id
                        record["remediation_task_id"] = child_id
                    else:
                        task.pop("remediation_task_id", None)
                else:
                    task.pop("failure_analysis", None)
                    task.pop("failure_summary", None)
                    remediation.resolve_tasks(data, task, "completed")
            return True

        if not roadmap_store.update_roadmap(path, apply):
            return VerificationResult("cancelled", code, tail, "Task changed during verification")
        return VerificationResult("skipped" if skipped else "verified" if code == 0 else "failed",
                                  code, tail, note, analysis)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("task_id")
    parser.add_argument("--dry-run", action="store_true", help="Print the command without running or writing")
    parser.add_argument("--project-root", type=Path, default=PROJECT_ROOT)
    parser.add_argument("--timeout", type=float, default=300)
    args = parser.parse_args()

    def stop(_signum: int, _frame: object) -> None:
        raise KeyboardInterrupt

    signal.signal(signal.SIGTERM, stop)
    try:
        result = verify_task(args.task_id, args.project_root, timeout=args.timeout, dry_run=args.dry_run)
    except (ValueError, OSError) as error:
        parser.exit(2, f"{error}\n")
    except KeyboardInterrupt:
        parser.exit(130, "Verification interrupted\n")
    print(json.dumps(asdict(result)))
    raise SystemExit(0 if result.outcome in {"verified", "skipped", "dry_run"} else 1)


if __name__ == "__main__":
    main()
