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

from command_runner import run_cmd
from failure_analysis import analyze_failure
import roadmap_store

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
    runner: Callable[[str, float, Path], tuple[int, str]] = run_cmd,
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
            code, output = runner(initial["verification_cmd"], timeout, project_root)
            tail, note = output[-LOG_LIMIT:], ""
            if code != 0:
                # Analyze the transport's bounded capture before reducing the
                # stored log tail; compiler/test diagnostics can precede noise.
                analysis = analyze_failure(code, output, initial["verification_cmd"]).to_dict()
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
                else:
                    task.pop("failure_analysis", None)
                    task.pop("failure_summary", None)
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
