"""Trusted API bridge to the repository scheduler's atomic roadmap store."""
from __future__ import annotations

import base64
from collections import deque
from dataclasses import asdict, dataclass, field
import hashlib
import json
from pathlib import Path
import queue
import struct
import sys
import threading
import time
import uuid
from datetime import datetime, timezone
from typing import Any, Callable, Generator

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
        get_event_bus(path.parent).publish_roadmap_sync(
            "budget_updated", task_id=task_id, details={"budget_cap_usd": cap}
        )
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
        get_event_bus(path.parent).publish_task_transition(
            task_id, "approved", previous_status="waiting_approval"
        )
        get_event_bus(path.parent).publish_roadmap_sync("task_approved", task_id=task_id)
    return result


# ---------------------------------------------------------------------------
# Real-Time Streaming Event Bus (SSE & WebSocket)
# ---------------------------------------------------------------------------

@dataclass
class StreamingEvent:
    type: str  # "task_transition", "console_log", "roadmap_sync", "telemetry", "snapshot", "ping", "connected"
    data: dict = field(default_factory=dict)
    task_id: str | None = None
    id: str = field(default_factory=lambda: str(uuid.uuid4()))
    timestamp: str = field(default_factory=lambda: datetime.now(timezone.utc).isoformat())

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "type": self.type,
            "task_id": self.task_id,
            "timestamp": self.timestamp,
            "data": self.data,
        }

    def to_sse(self) -> str:
        payload = json.dumps(self.to_dict())
        return f"id: {self.id}\nevent: {self.type}\ndata: {payload}\n\n"

    def to_ws_frame(self) -> bytes:
        payload = json.dumps(self.to_dict())
        return encode_ws_frame(payload, opcode=0x01)


def format_sse(event_type: str, data: Any, event_id: str | None = None) -> str:
    """Format an SSE frame."""
    payload = json.dumps(data) if not isinstance(data, str) else data
    id_line = f"id: {event_id}\n" if event_id else ""
    return f"{id_line}event: {event_type}\ndata: {payload}\n\n"


def make_ws_accept(key: str) -> str:
    """Compute the Sec-WebSocket-Accept header value per RFC 6455."""
    guid = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
    return base64.b64encode(hashlib.sha1((key.strip() + guid).encode("utf-8")).digest()).decode("utf-8")


def encode_ws_frame(payload: str | bytes, opcode: int = 0x01) -> bytes:
    """Encode payload into an RFC 6455 unmasked WebSocket frame."""
    raw = payload.encode("utf-8") if isinstance(payload, str) else payload
    length = len(raw)
    header = bytearray([0x80 | (opcode & 0x0F)])
    if length <= 125:
        header.append(length)
    elif length <= 65535:
        header.append(126)
        header.extend(struct.pack("!H", length))
    else:
        header.append(127)
        header.extend(struct.pack("!Q", length))
    return bytes(header) + raw


def decode_ws_frame(data: bytes) -> tuple[int | None, bytes | None, bytes]:
    """Decode a WebSocket frame from bytes.

    Returns (opcode, unmasked_payload, remaining_bytes) or (None, None, data) if incomplete.
    """
    if len(data) < 2:
        return None, None, data
    byte1, byte2 = data[0], data[1]
    opcode = byte1 & 0x0F
    masked = bool(byte2 & 0x80)
    length = byte2 & 0x7F
    offset = 2
    if length == 126:
        if len(data) < 4:
            return None, None, data
        length = struct.unpack("!H", data[2:4])[0]
        offset = 4
    elif length == 127:
        if len(data) < 10:
            return None, None, data
        length = struct.unpack("!Q", data[2:10])[0]
        offset = 10
    mask_key = None
    if masked:
        if len(data) < offset + 4:
            return None, None, data
        mask_key = data[offset:offset + 4]
        offset += 4
    if len(data) < offset + length:
        return None, None, data
    payload = data[offset:offset + length]
    if masked and mask_key:
        payload = bytes(b ^ mask_key[i % 4] for i, b in enumerate(payload))
    remaining = data[offset + length:]
    return opcode, payload, remaining


class StreamingEventBus:
    """Thread-safe event bus for publishing and streaming real-time telemetry,
    orchestrator logs, and roadmap sync updates to SSE and WebSocket clients.
    """

    def __init__(self, project_root: Path | None = None) -> None:
        self.project_root = Path(project_root).resolve() if project_root else None
        self._lock = threading.Lock()
        self._subscribers: list[tuple[queue.Queue, set[str] | None, set[str] | None]] = []
        self._listener_unsub: Callable[[], None] | None = None
        self._watcher_thread: threading.Thread | None = None
        self._watcher_stop: threading.Event = threading.Event()
        self._last_log_offset = 0
        self._last_roadmap_mtime = 0.0
        self._last_tasks_snapshot: dict[str, dict] = {}
        self._seen_log_ids: deque[str] = deque(maxlen=1000)

        # Connect to build_events in-process emitter
        self._listener_unsub = build_events.register_listener(self._on_build_event)

    def _on_build_event(self, record: dict) -> None:
        """Handler called whenever build_events.emit is executed in-process."""
        rec_id = record.get("id")
        if rec_id:
            with self._lock:
                self._seen_log_ids.append(rec_id)
        task_id = record.get("task_id")
        self.publish(
            event_type="console_log",
            data={
                "id": rec_id,
                "task_id": task_id,
                "source": record.get("source", "orchestrator"),
                "message": record.get("message", ""),
                "timestamp": record.get("timestamp", datetime.now(timezone.utc).isoformat()),
            },
            task_id=task_id,
        )

    @property
    def subscriber_count(self) -> int:
        with self._lock:
            return len(self._subscribers)

    def subscribe(
        self,
        task_ids: set[str] | None = None,
        event_types: set[str] | None = None,
        maxsize: int = 1000,
    ) -> queue.Queue:
        q: queue.Queue = queue.Queue(maxsize=maxsize)
        with self._lock:
            self._subscribers.append((q, task_ids, event_types))
        return q

    def unsubscribe(self, q: queue.Queue) -> None:
        with self._lock:
            self._subscribers = [s for s in self._subscribers if s[0] is not q]

    def publish(
        self,
        event_type: str,
        data: dict,
        task_id: str | None = None,
    ) -> StreamingEvent:
        event = StreamingEvent(
            type=event_type,
            data=data,
            task_id=task_id,
        )
        with self._lock:
            subs = list(self._subscribers)

        for q, task_filter, type_filter in subs:
            # Check event_type filter
            if type_filter and event_type not in type_filter:
                continue
            # Check task_id filter
            if task_filter and task_id and task_id not in task_filter:
                continue
            try:
                q.put_nowait(event)
            except queue.Full:
                # Bounded queue: drop oldest event to avoid memory growth on slow consumers
                try:
                    q.get_nowait()
                except queue.Empty:
                    pass
                try:
                    q.put_nowait(event)
                except queue.Full:
                    pass
        return event

    def publish_task_transition(
        self,
        task_id: str,
        status: str,
        previous_status: str | None = None,
        commit_sha: str | None = None,
        pr_ref: str | None = None,
        github_issue_number: int | None = None,
        **extra: Any,
    ) -> StreamingEvent:
        data = {
            "task_id": task_id,
            "status": status,
            "previous_status": previous_status,
            "commit_sha": commit_sha,
            "pr_ref": pr_ref,
            "github_issue_number": github_issue_number,
            "timestamp": datetime.now(timezone.utc).isoformat(),
            **extra,
        }
        return self.publish("task_transition", data, task_id=task_id)

    def publish_console_log(
        self,
        task_id: str,
        source: str,
        message: str,
        log_id: str | None = None,
        **extra: Any,
    ) -> StreamingEvent:
        data = {
            "id": log_id or str(uuid.uuid4()),
            "task_id": task_id,
            "source": source,
            "message": message[:4000],
            "timestamp": datetime.now(timezone.utc).isoformat(),
            **extra,
        }
        return self.publish("console_log", data, task_id=task_id)

    def publish_roadmap_sync(
        self,
        action: str,
        task_id: str | None = None,
        details: dict | None = None,
        **extra: Any,
    ) -> StreamingEvent:
        data = {
            "action": action,
            "task_id": task_id,
            "details": details or {},
            "timestamp": datetime.now(timezone.utc).isoformat(),
            **extra,
        }
        return self.publish("roadmap_sync", data, task_id=task_id)

    def publish_telemetry(
        self,
        task_id: str,
        telemetry: dict,
        **extra: Any,
    ) -> StreamingEvent:
        data = {
            "task_id": task_id,
            "telemetry": telemetry,
            "timestamp": datetime.now(timezone.utc).isoformat(),
            **extra,
        }
        return self.publish("telemetry", data, task_id=task_id)

    def start_file_watcher(self, root: Path, poll_interval: float = 0.5) -> None:
        if self._watcher_thread and self._watcher_thread.is_alive():
            return
        self.project_root = Path(root).resolve()
        self._watcher_stop.clear()

        log_path = self.project_root / "logs" / "build.jsonl"
        if log_path.exists():
            try:
                self._last_log_offset = log_path.stat().st_size
            except Exception:
                self._last_log_offset = 0

        roadmap_path = self.project_root / "ROADMAP.json"
        if roadmap_path.exists():
            try:
                self._last_roadmap_mtime = roadmap_path.stat().st_mtime
                data = json.loads(roadmap_path.read_text(encoding="utf-8"))
                self._last_tasks_snapshot = {t["id"]: t for t in data.get("tasks", []) if isinstance(t, dict) and "id" in t}
            except Exception:
                pass

        def _watch_loop():
            while not self._watcher_stop.is_set():
                try:
                    self._poll_log_file()
                    self._poll_roadmap_file()
                except Exception:
                    pass
                self._watcher_stop.wait(poll_interval)

        self._watcher_thread = threading.Thread(target=_watch_loop, daemon=True, name="EventBusWatcher")
        self._watcher_thread.start()

    def stop_file_watcher(self) -> None:
        self._watcher_stop.set()
        if self._watcher_thread and self._watcher_thread.is_alive():
            self._watcher_thread.join(timeout=2.0)
        self._watcher_thread = None

    def _poll_log_file(self) -> None:
        if not self.project_root:
            return
        log_path = self.project_root / "logs" / "build.jsonl"
        if not log_path.exists():
            return
        try:
            size = log_path.stat().st_size
            if size < self._last_log_offset:
                self._last_log_offset = 0
            if size > self._last_log_offset:
                with log_path.open("r", encoding="utf-8", errors="replace") as f:
                    f.seek(self._last_log_offset)
                    lines = f.readlines()
                    self._last_log_offset = f.tell()
                for line in lines:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        record = json.loads(line)
                        rec_id = record.get("id")
                        with self._lock:
                            if rec_id and rec_id in self._seen_log_ids:
                                continue
                            if rec_id:
                                self._seen_log_ids.append(rec_id)
                        self.publish(
                            "console_log",
                            {
                                "id": rec_id,
                                "task_id": record.get("task_id"),
                                "source": record.get("source", "orchestrator"),
                                "message": record.get("message", ""),
                                "timestamp": record.get("timestamp"),
                            },
                            task_id=record.get("task_id"),
                        )
                    except Exception:
                        pass
        except Exception:
            pass

    def _poll_roadmap_file(self) -> None:
        if not self.project_root:
            return
        roadmap_path = self.project_root / "ROADMAP.json"
        if not roadmap_path.exists():
            return
        try:
            mtime = roadmap_path.stat().st_mtime
            if mtime != self._last_roadmap_mtime:
                self._last_roadmap_mtime = mtime
                data = json.loads(roadmap_path.read_text(encoding="utf-8"))
                current_tasks = {t["id"]: t for t in data.get("tasks", []) if isinstance(t, dict) and "id" in t}
                for tid, task in current_tasks.items():
                    prev = self._last_tasks_snapshot.get(tid)
                    if prev:
                        if prev.get("status") != task.get("status"):
                            self.publish_task_transition(
                                task_id=tid,
                                status=task.get("status", ""),
                                previous_status=prev.get("status"),
                                commit_sha=task.get("commit_sha"),
                                pr_ref=task.get("pr_number"),
                                github_issue_number=issue_number_for_task(task),
                            )
                    else:
                        self.publish_roadmap_sync(
                            action="task_created",
                            task_id=tid,
                            details={"title": task.get("title")},
                        )
                self._last_tasks_snapshot = current_tasks
        except Exception:
            pass

    def close(self) -> None:
        self.stop_file_watcher()
        if self._listener_unsub:
            self._listener_unsub()
            self._listener_unsub = None
        with self._lock:
            self._subscribers.clear()


_buses: dict[str, StreamingEventBus] = {}
_bus_lock = threading.Lock()


def get_event_bus(root: Path | str | None = None) -> StreamingEventBus:
    key = str(Path(root).resolve()) if root else "default"
    with _bus_lock:
        if key not in _buses:
            _buses[key] = StreamingEventBus(project_root=Path(root) if root else None)
        return _buses[key]


def reset_event_buses() -> None:
    with _bus_lock:
        for bus in _buses.values():
            bus.close()
        _buses.clear()


def stream_dashboard_events(
    path: Path,
    identity: dict,
    project_id: str,
    event_bus: StreamingEventBus | None = None,
    task_ids: set[str] | None = None,
    event_types: set[str] | None = None,
    heartbeat_interval: float = 15.0,
    max_events: int | None = None,
) -> Generator[str, None, None]:
    """Yield SSE-formatted stream events for tenant-scoped dashboard clients.

    Emits an initial snapshot event, then real-time updates as they happen,
    with periodic heartbeat ping comments.
    """
    bus = event_bus or get_event_bus(path.parent)
    init_snap = snapshot(path, identity, project_id)
    visible_task_ids = {t["id"] for t in init_snap["tasks"]}
    if task_ids:
        effective_task_ids = task_ids & visible_task_ids
    else:
        effective_task_ids = visible_task_ids

    q = bus.subscribe(task_ids=effective_task_ids if effective_task_ids else None, event_types=event_types)
    count = 1
    try:
        yield format_sse("snapshot", init_snap)
        while max_events is None or count < max_events:
            try:
                event = q.get(timeout=heartbeat_interval)
                if event.task_id and event.task_id not in visible_task_ids:
                    fresh_snap = snapshot(path, identity, project_id)
                    visible_task_ids = {t["id"] for t in fresh_snap["tasks"]}
                    if event.task_id not in visible_task_ids:
                        continue
                yield event.to_sse()
                count += 1
            except queue.Empty:
                yield ": ping\n\n"
    finally:
        bus.unsubscribe(q)


if __name__ == "__main__":
    path = Path(sys.argv[1])
    request = json.load(sys.stdin)
    result = {}
    if request["operation"] == "approve":
        result = approve(path, request["identity"], request["projectId"], request["taskId"], request["revision"])
    elif request["operation"] == "budget":
        result = set_budget(path, request["identity"], request["projectId"], request["taskId"],
                            request["revision"], request["budget_cap_usd"])
    elif request["operation"] == "stream":
        for chunk in stream_dashboard_events(
            path, request["identity"], request["projectId"],
            max_events=request.get("max_events"),
        ):
            sys.stdout.write(chunk)
            sys.stdout.flush()
        sys.exit(0)
    if "error" not in result:
        result = snapshot(path, request["identity"], request["projectId"])
    print(json.dumps(result))
