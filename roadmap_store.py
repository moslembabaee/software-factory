"""Serialize roadmap writers and preserve closure against stale agent snapshots."""

import fcntl
import json
import os
import tempfile
from pathlib import Path


def update_roadmap(path: Path, update) -> bool:
    with path.with_suffix(".json.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        data = json.loads(path.read_text(encoding="utf-8"))
        if not update(data):
            return False
        # Readers always see a complete JSON document, even during a write.
        temp_path = None
        try:
            with tempfile.NamedTemporaryFile(mode="w", dir=path.parent, delete=False,
                                             encoding="utf-8") as temp:
                temp_path = Path(temp.name)
                temp_path.chmod(path.stat().st_mode & 0o777)
                json.dump(data, temp, indent=2)
                temp.flush()
                os.fsync(temp.fileno())
            temp_path.replace(path)
        finally:
            if temp_path is not None:
                temp_path.unlink(missing_ok=True)
        return True


def save_roadmap(path: Path, snapshot: dict):
    def merge(latest):
        # Intake receipts are immutable. Preserve concurrent acceptances even
        # when an orchestrator saves a snapshot taken before the Ask write.
        receipts = {**snapshot.get("ask_intakes", {}), **latest.get("ask_intakes", {})}
        incoming = {task["id"]: task for task in snapshot.get("tasks", [])}
        for task in latest.get("tasks", []):
            if (task.get("closed_at") or task["id"] not in incoming or
                    task.get("build_approval") != incoming[task["id"]].get("build_approval")):
                incoming[task["id"]] = task
        latest.update(snapshot)
        latest["tasks"] = list(incoming.values())
        if receipts:
            latest["ask_intakes"] = receipts
        if any(task.get("closed_at") and task["id"] == latest.get("current_task_id")
               for task in latest["tasks"]):
            latest["current_task_id"] = None
        return True

    update_roadmap(path, merge)
