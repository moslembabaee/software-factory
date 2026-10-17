"""Task-scoped activity feed and real-time streaming event bus."""
from __future__ import annotations

from collections import deque
from datetime import datetime, timezone
import fcntl
import json
from pathlib import Path
import queue
import threading
import time
import uuid


class EventBus:
    """Thread-safe pub/sub event bus for live streaming telemetry and logs."""

    def __init__(self, history_limit: int = 1000):
        self._lock = threading.Lock()
        self._subscribers: set[queue.Queue] = set()
        self._recent_ids: deque[str] = deque(maxlen=history_limit)

    def subscribe(self, maxsize: int = 500) -> queue.Queue:
        q: queue.Queue = queue.Queue(maxsize=maxsize)
        with self._lock:
            self._subscribers.add(q)
        return q

    def unsubscribe(self, q: queue.Queue) -> None:
        with self._lock:
            self._subscribers.discard(q)

    def publish(self, event: dict) -> None:
        event_id = event.get("id")
        with self._lock:
            if event_id:
                if event_id in self._recent_ids:
                    return
                self._recent_ids.append(event_id)
            subscribers = list(self._subscribers)

        for q in subscribers:
            try:
                q.put_nowait(event)
            except queue.Full:
                try:
                    q.get_nowait()
                    q.put_nowait(event)
                except Exception:
                    pass

    def subscriber_count(self) -> int:
        with self._lock:
            return len(self._subscribers)

    def clear(self) -> None:
        with self._lock:
            self._subscribers.clear()
            self._recent_ids.clear()


GLOBAL_BUS = EventBus()


def emit(
    root: Path,
    task_id: str,
    source: str,
    message: str,
    event_type: str = "agent_log",
    extra: dict | None = None,
    bus: EventBus | None = None,
) -> dict:
    """Emit a task-scoped event, persisting to build.jsonl and publishing to the bus."""
    root = Path(root)
    directory = root / "logs"
    directory.mkdir(exist_ok=True)
    record = {
        "id": str(uuid.uuid4()),
        "task_id": task_id,
        "source": source,
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "message": message[:4000],
        "event_type": event_type,
    }
    if extra:
        record.update(extra)

    with (directory / "build.jsonl").open("a", encoding="utf-8") as output:
        fcntl.flock(output, fcntl.LOCK_EX)
        output.write(json.dumps(record) + "\n")

    (bus or GLOBAL_BUS).publish(record)
    return record


def emit_task_transition(
    root: Path,
    task_id: str,
    status: str,
    previous_status: str | None = None,
    commit_sha: str | None = None,
    pr_ref: str | int | None = None,
    source: str = "orchestrator",
    message: str | None = None,
    bus: EventBus | None = None,
) -> dict:
    """Emit a task status transition event."""
    msg = message or f"Task {task_id} transitioned to {status}"
    extra = {
        "status": status,
        "previous_status": previous_status,
        "commit_sha": commit_sha,
        "pr_ref": pr_ref,
    }
    return emit(
        root,
        task_id,
        source,
        msg,
        event_type="task_transition",
        extra=extra,
        bus=bus,
    )


def emit_roadmap_sync(
    root: Path,
    action: str,
    synced_count: int = 0,
    issue_number: int | None = None,
    details: dict | None = None,
    source: str = "webhook",
    bus: EventBus | None = None,
) -> dict:
    """Emit a roadmap synchronization event."""
    msg = f"Roadmap sync: {action} ({synced_count} tasks)"
    extra = {
        "action": action,
        "synced_count": synced_count,
        "issue_number": issue_number,
        "details": details or {},
    }
    return emit(
        root,
        "",
        source,
        msg,
        event_type="roadmap_sync",
        extra=extra,
        bus=bus,
    )


def emit_telemetry(
    root: Path,
    task_id: str,
    telemetry: dict | None = None,
    active_attempt: dict | None = None,
    source: str = "orchestrator",
    bus: EventBus | None = None,
) -> dict:
    """Emit real-time task telemetry metrics."""
    extra = {
        "telemetry": telemetry or {},
        "active_attempt": active_attempt,
    }
    return emit(
        root,
        task_id,
        source,
        f"Telemetry update for {task_id}",
        event_type="telemetry",
        extra=extra,
        bus=bus,
    )


def format_sse(event_name: str, data: dict | str, event_id: str | None = None) -> str:
    """Format an event payload according to the W3C Server-Sent Events specification."""
    payload = json.dumps(data) if isinstance(data, (dict, list)) else str(data)
    lines = [f"event: {event_name}"]
    if event_id:
        lines.append(f"id: {event_id}")
    for line in payload.splitlines():
        lines.append(f"data: {line}")
    return "\n".join(lines) + "\n\n"


def format_ws_frame(data: dict | str) -> bytes:
    """Encode an unmasked RFC 6455 WebSocket frame."""
    payload = json.dumps(data).encode("utf-8") if isinstance(data, (dict, list)) else str(data).encode("utf-8")
    length = len(payload)
    if length <= 125:
        header = bytes([0x81, length])
    elif length <= 65535:
        header = bytes([0x81, 126]) + length.to_bytes(2, "big")
    else:
        header = bytes([0x81, 127]) + length.to_bytes(8, "big")
    return header + payload


def stream_events(
    task_ids: set[str] | None = None,
    event_types: set[str] | None = None,
    timeout: float | None = None,
    heartbeat_interval: float = 15.0,
    bus: EventBus | None = None,
):
    """Yield formatted SSE events from the bus matching task IDs and event types."""
    bus = bus or GLOBAL_BUS
    q = bus.subscribe()
    start = time.time()
    try:
        while True:
            if timeout is not None and (time.time() - start) >= timeout:
                break
            try:
                event = q.get(timeout=heartbeat_interval)
                if task_ids is not None and event.get("task_id") and event.get("task_id") not in task_ids:
                    continue
                etype = event.get("event_type", "agent_log")
                if event_types is not None and etype not in event_types:
                    continue
                yield format_sse(etype, event, event_id=event.get("id"))
            except queue.Empty:
                yield ": keepalive\n\n"
    finally:
        bus.unsubscribe(q)


def start_log_follower(
    root: Path,
    bus: EventBus | None = None,
    poll_interval: float = 0.2,
) -> threading.Thread:
    """Watch logs/build.jsonl for new entries written by concurrent processes and publish to bus."""
    bus = bus or GLOBAL_BUS
    path = Path(root) / "logs" / "build.jsonl"

    def run_loop():
        last_pos = 0
        if path.exists():
            try:
                last_pos = path.stat().st_size
            except OSError:
                pass
        while True:
            try:
                if path.exists():
                    size = path.stat().st_size
                    if size > last_pos:
                        with path.open("r", encoding="utf-8", errors="replace") as f:
                            f.seek(last_pos)
                            lines = f.readlines()
                            last_pos = f.tell()
                        for line in lines:
                            line = line.strip()
                            if not line:
                                continue
                            try:
                                record = json.loads(line)
                                bus.publish(record)
                            except Exception:
                                pass
                    elif size < last_pos:
                        last_pos = 0
            except Exception:
                pass
            time.sleep(poll_interval)

    thread = threading.Thread(target=run_loop, daemon=True, name="BuildLogFollower")
    thread.start()
    return thread


def tail(root: Path, task_ids: set[str]) -> list[dict]:
    path = Path(root) / "logs" / "build.jsonl"
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
                records.append({
                    "id": record["id"],
                    "task_id": record["task_id"],
                    "source": record["source"],
                    "timestamp": record["timestamp"],
                    "message": record["message"][:4000],
                })
        except (ValueError, AttributeError, KeyError):
            continue  # A concurrent writer may not have finished the last line.
    return records[-200:]
