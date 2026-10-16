"""Task-scoped activity feed. Never copy unscoped repository logs to a tenant UI."""
import fcntl
import json
import uuid
from datetime import datetime, timezone
from pathlib import Path


def emit(root: Path, task_id: str, source: str, message: str):
    directory = root / "logs"
    directory.mkdir(exist_ok=True)
    record = {"id": str(uuid.uuid4()), "task_id": task_id, "source": source,
              "timestamp": datetime.now(timezone.utc).isoformat(), "message": message[:4000]}
    with (directory / "build.jsonl").open("a", encoding="utf-8") as output:
        fcntl.flock(output, fcntl.LOCK_EX)
        output.write(json.dumps(record) + "\n")
    try:
        import event_bus
        event_bus.publish("log", record, event_id=record["id"])
    except Exception:
        pass


def tail(root: Path, task_ids: set[str]) -> list[dict]:
    path = root / "logs" / "build.jsonl"
    try:
        with path.open("rb") as source:
            source.seek(0, 2)
            start = max(0, source.tell() - 262144)
            source.seek(start)
            if start:
                source.readline()  # Discard a potentially partial first record.
            lines = source.read(262144).splitlines()
    except FileNotFoundError:
        return []
    records = []
    for line in lines:
        try:
            record = json.loads(line)
            if record.get("task_id") in task_ids:
                records.append(record)
        except (ValueError, AttributeError):
            continue  # A concurrent writer may not have finished the last line.
    return records[-200:]
