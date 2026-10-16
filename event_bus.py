"""Real-time streaming event bus for orchestrator logs, task transitions, and dashboard telemetry."""
from __future__ import annotations

import base64
import hashlib
import json
import queue
import select
import struct
import threading
import time
import urllib.parse
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Generator

WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"


class QueueSubscriber:
    """Thread-safe subscriber queue that filters and buffers published events."""

    def __init__(
        self,
        bus: EventBus,
        types: set[str] | None = None,
        filter_fn: Callable[[dict], bool] | None = None,
        maxsize: int = 1000,
    ) -> None:
        self.bus = bus
        self.types = set(types) if types else None
        self.filter_fn = filter_fn
        self.queue: queue.Queue[dict] = queue.Queue(maxsize=maxsize)
        self.closed = False

    def put(self, event: dict) -> None:
        if self.closed:
            return
        if self.types and event.get("type") not in self.types and "*" not in self.types:
            return
        if self.filter_fn:
            try:
                if not self.filter_fn(event):
                    return
            except Exception:
                return
        try:
            self.queue.put_nowait(event)
        except queue.Full:
            # Drop oldest item to prevent unbounded memory growth from slow consumers
            try:
                self.queue.get_nowait()
            except queue.Empty:
                pass
            try:
                self.queue.put_nowait(event)
            except queue.Full:
                pass

    def get(self, timeout: float | None = None) -> dict | None:
        if self.closed:
            return None
        try:
            item = self.queue.get(timeout=timeout)
            if item is None or self.closed:
                return None
            return item
        except queue.Empty:
            return None

    def close(self) -> None:
        self.closed = True
        self.bus.unsubscribe_queue(self)
        try:
            self.queue.put_nowait(None)
        except Exception:
            pass


class EventBus:
    """In-memory publish/subscribe event bus supporting callbacks, queues, and streaming."""

    def __init__(self) -> None:
        self._lock = threading.RLock()
        self._subscribers: dict[str, list[Callable[[dict], None]]] = {}
        self._queues: list[QueueSubscriber] = []

    def subscribe(
        self,
        event_type: str = "*",
        callback: Callable[[dict], None] | None = None,
    ) -> Callable[[], None]:
        with self._lock:
            subs = self._subscribers.setdefault(event_type, [])
            if callback and callback not in subs:
                subs.append(callback)

        def unsubscribe() -> None:
            with self._lock:
                if event_type in self._subscribers and callback in self._subscribers[event_type]:
                    self._subscribers[event_type].remove(callback)

        return unsubscribe

    def subscribe_queue(
        self,
        event_types: set[str] | list[str] | None = None,
        filter_fn: Callable[[dict], bool] | None = None,
        maxsize: int = 1000,
    ) -> QueueSubscriber:
        sub = QueueSubscriber(
            self,
            types=set(event_types) if event_types else None,
            filter_fn=filter_fn,
            maxsize=maxsize,
        )
        with self._lock:
            self._queues.append(sub)
        return sub

    def unsubscribe_queue(self, sub: QueueSubscriber) -> None:
        with self._lock:
            if sub in self._queues:
                self._queues.remove(sub)

    def publish(
        self,
        event_type: str,
        data: dict,
        event_id: str | None = None,
    ) -> dict:
        event = {
            "id": event_id or str(uuid.uuid4()),
            "type": event_type,
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "data": data,
        }
        with self._lock:
            callbacks = list(self._subscribers.get(event_type, []))
            if event_type != "*":
                callbacks.extend(self._subscribers.get("*", []))
            queues = list(self._queues)

        for cb in callbacks:
            try:
                cb(event)
            except Exception:
                pass

        for q in queues:
            q.put(event)

        return event

    def reset(self) -> None:
        with self._lock:
            self._subscribers.clear()
            for q in self._queues:
                q.closed = True
            self._queues.clear()


_DEFAULT_BUS = EventBus()


def get_event_bus() -> EventBus:
    return _DEFAULT_BUS


def publish(event_type: str, data: dict, event_id: str | None = None) -> dict:
    return _DEFAULT_BUS.publish(event_type, data, event_id=event_id)


def subscribe(
    event_type: str = "*",
    callback: Callable[[dict], None] | None = None,
) -> Callable[[], None]:
    return _DEFAULT_BUS.subscribe(event_type, callback)


def subscribe_queue(
    event_types: set[str] | list[str] | None = None,
    filter_fn: Callable[[dict], bool] | None = None,
    maxsize: int = 1000,
) -> QueueSubscriber:
    return _DEFAULT_BUS.subscribe_queue(event_types=event_types, filter_fn=filter_fn, maxsize=maxsize)


def emit_task_transition(
    task_id: str,
    status: str,
    previous_status: str | None = None,
    event_id: str | None = None,
    **kwargs: Any,
) -> dict:
    data = {"task_id": task_id, "status": status, **kwargs}
    if previous_status is not None:
        data["previous_status"] = previous_status
    return _DEFAULT_BUS.publish("task_transition", data, event_id=event_id)


def emit_roadmap_sync(
    action: str,
    task_id: str | None = None,
    event_id: str | None = None,
    **kwargs: Any,
) -> dict:
    data = {"action": action, **kwargs}
    if task_id is not None:
        data["task_id"] = task_id
    return _DEFAULT_BUS.publish("roadmap_sync", data, event_id=event_id)


def format_sse(event_type: str, data: Any, event_id: str | None = None) -> str:
    lines = []
    if event_id:
        lines.append(f"id: {event_id}")
    lines.append(f"event: {event_type}")
    payload = json.dumps(data) if not isinstance(data, str) else data
    for line in payload.splitlines():
        lines.append(f"data: {line}")
    if not payload:
        lines.append("data: ")
    return "\n".join(lines) + "\n\n"


def format_keepalive() -> str:
    return ": keepalive\n\n"


def compute_websocket_accept(key: str) -> str:
    sha = hashlib.sha1((key.strip() + WS_GUID).encode("utf-8")).digest()
    return base64.b64encode(sha).decode("utf-8")


def encode_websocket_frame(payload: str | bytes, opcode: int = 1) -> bytes:
    data = payload.encode("utf-8") if isinstance(payload, str) else payload
    length = len(data)
    header = bytearray([0x80 | (opcode & 0x0F)])
    if length <= 125:
        header.append(length)
    elif length <= 65535:
        header.append(126)
        header.extend(struct.pack(">H", length))
    else:
        header.append(127)
        header.extend(struct.pack(">Q", length))
    return bytes(header) + data


def decode_websocket_frame(stream) -> tuple[int, bytes] | None:
    def _read_exact(n: int) -> bytes | None:
        buf = bytearray()
        while len(buf) < n:
            try:
                if hasattr(stream, "read"):
                    chunk = stream.read(n - len(buf))
                elif hasattr(stream, "recv"):
                    chunk = stream.recv(n - len(buf))
                else:
                    return None
            except (TimeoutError, BlockingIOError):
                break
            except OSError:
                return None
            if not chunk:
                break
            buf.extend(chunk)
        if len(buf) < n:
            return None
        return bytes(buf)

    head = _read_exact(2)
    if not head:
        return None
    b1, b2 = head[0], head[1]
    opcode = b1 & 0x0F
    has_mask = (b2 & 0x80) != 0
    length = b2 & 0x7F
    if length == 126:
        ext = _read_exact(2)
        if not ext:
            return None
        length = struct.unpack(">H", ext)[0]
    elif length == 127:
        ext = _read_exact(8)
        if not ext:
            return None
        length = struct.unpack(">Q", ext)[0]
    mask = _read_exact(4) if has_mask else b""
    if has_mask and (not mask or len(mask) < 4):
        return None
    payload = _read_exact(length) if length > 0 else b""
    if payload is None:
        return None
    data = bytearray(payload)
    if has_mask:
        for i in range(len(data)):
            data[i] ^= mask[i % 4]
    return opcode, bytes(data)


def handle_sse_stream(
    handler,
    subscriber: QueueSubscriber,
    initial_events: list[tuple[str, Any]] | None = None,
    ping_interval: float = 15.0,
    stop_event: threading.Event | None = None,
) -> None:
    handler.send_response(200)
    handler.send_header("Content-Type", "text/event-stream; charset=utf-8")
    handler.send_header("Cache-Control", "no-cache, no-transform")
    handler.send_header("Connection", "keep-alive")
    handler.send_header("Access-Control-Allow-Origin", "*")
    handler.end_headers()

    try:
        if initial_events:
            for etype, edata in initial_events:
                msg = format_sse(etype, edata)
                handler.wfile.write(msg.encode("utf-8"))
            handler.wfile.flush()

        while not subscriber.closed and (not stop_event or not stop_event.is_set()):
            event = subscriber.get(timeout=ping_interval)
            if event:
                msg = format_sse(event["type"], event["data"], event.get("id"))
                handler.wfile.write(msg.encode("utf-8"))
                handler.wfile.flush()
            else:
                handler.wfile.write(format_keepalive().encode("utf-8"))
                handler.wfile.flush()
    except (BrokenPipeError, ConnectionResetError, OSError):
        pass
    finally:
        subscriber.close()


def handle_websocket_stream(
    handler,
    subscriber: QueueSubscriber,
    initial_events: list[tuple[str, Any]] | None = None,
    ping_interval: float = 20.0,
    stop_event: threading.Event | None = None,
) -> None:
    key = handler.headers.get("Sec-WebSocket-Key")
    if not key:
        handler.send_error(400, "Missing Sec-WebSocket-Key")
        return

    accept = compute_websocket_accept(key)
    handler.send_response(101, "Switching Protocols")
    handler.send_header("Upgrade", "websocket")
    handler.send_header("Connection", "Upgrade")
    handler.send_header("Sec-WebSocket-Accept", accept)
    handler.end_headers()

    try:
        raw_sock = getattr(handler, "connection", None)
        if raw_sock is not None:
            try:
                raw_sock.settimeout(0.5)
            except Exception:
                pass

        if initial_events:
            for etype, edata in initial_events:
                payload = json.dumps({
                    "event": etype,
                    "data": edata,
                    "timestamp": datetime.now(timezone.utc).isoformat(),
                })
                handler.wfile.write(encode_websocket_frame(payload))
            handler.wfile.flush()

        while not subscriber.closed and (not stop_event or not stop_event.is_set()):
            if raw_sock is not None:
                try:
                    readable, _, _ = select.select([raw_sock], [], [], 0.05)
                except Exception:
                    readable = False
                if readable:
                    try:
                        res = decode_websocket_frame(handler.rfile)
                        if res is None:
                            break
                        opcode, payload = res
                        if opcode == 0x8:  # Close
                            try:
                                handler.wfile.write(encode_websocket_frame(payload, opcode=0x8))
                                handler.wfile.flush()
                            except Exception:
                                pass
                            break
                        elif opcode == 0x9:  # Ping
                            handler.wfile.write(encode_websocket_frame(payload, opcode=0xA))
                            handler.wfile.flush()
                    except (TimeoutError, OSError):
                        break

            event = subscriber.get(timeout=ping_interval)
            if event:
                payload = json.dumps({
                    "event": event["type"],
                    "data": event["data"],
                    "id": event.get("id"),
                    "timestamp": event.get("timestamp"),
                })
                handler.wfile.write(encode_websocket_frame(payload))
                handler.wfile.flush()
            else:
                handler.wfile.write(encode_websocket_frame(b"", opcode=0x9))
                handler.wfile.flush()
    except (BrokenPipeError, ConnectionResetError, OSError):
        pass
    finally:
        subscriber.close()


class LogFollower(threading.Thread):
    """Background follower that polls logs/build.jsonl and ROADMAP.json for cross-process events."""

    def __init__(self, root: Path, bus: EventBus | None = None, interval: float = 0.2) -> None:
        super().__init__(daemon=True, name="EventBusLogFollower")
        self.root = root
        self.bus = bus or get_event_bus()
        self.interval = interval
        self.stopped = threading.Event()
        self.seen_ids: set[str] = set()
        self.last_pos = 0
        self.last_roadmap_mtime = 0.0
        self.task_statuses: dict[str, str] = {}
        self._init_pos()

    def _init_pos(self) -> None:
        log_file = self.root / "logs" / "build.jsonl"
        if log_file.exists():
            try:
                self.last_pos = log_file.stat().st_size
            except OSError:
                self.last_pos = 0
        roadmap = self.root / "ROADMAP.json"
        if roadmap.exists():
            try:
                self.last_roadmap_mtime = roadmap.stat().st_mtime
                data = json.loads(roadmap.read_text(encoding="utf-8"))
                for t in data.get("tasks", []):
                    tid = t.get("id")
                    if tid:
                        self.task_statuses[tid] = t.get("status", "")
            except Exception:
                pass

    def stop(self) -> None:
        self.stopped.set()

    def run(self) -> None:
        log_file = self.root / "logs" / "build.jsonl"
        roadmap = self.root / "ROADMAP.json"

        while not self.stopped.is_set():
            # 1. Read newly appended build logs
            if log_file.exists():
                try:
                    size = log_file.stat().st_size
                    if size < self.last_pos:
                        self.last_pos = 0
                    if size > self.last_pos:
                        with log_file.open("r", encoding="utf-8", errors="replace") as f:
                            f.seek(self.last_pos)
                            lines = f.readlines()
                            self.last_pos = f.tell()
                        for line in lines:
                            line = line.strip()
                            if not line:
                                continue
                            try:
                                record = json.loads(line)
                                rid = record.get("id")
                                if rid and rid in self.seen_ids:
                                    continue
                                if rid:
                                    self.seen_ids.add(rid)
                                    if len(self.seen_ids) > 10000:
                                        self.seen_ids = set(list(self.seen_ids)[-5000:])
                                self.bus.publish("log", record, event_id=rid)
                            except Exception:
                                pass
                except OSError:
                    pass

            # 2. Check for ROADMAP.json updates
            if roadmap.exists():
                try:
                    mtime = roadmap.stat().st_mtime
                    if mtime > self.last_roadmap_mtime:
                        self.last_roadmap_mtime = mtime
                        try:
                            data = json.loads(roadmap.read_text(encoding="utf-8"))
                            for t in data.get("tasks", []):
                                tid = t.get("id")
                                if not tid:
                                    continue
                                current_status = t.get("status", "")
                                old_status = self.task_statuses.get(tid)
                                if old_status is not None and old_status != current_status:
                                    self.bus.publish("task_transition", {
                                        "task_id": tid,
                                        "status": current_status,
                                        "previous_status": old_status,
                                        "title": t.get("title", ""),
                                        "tenant_id": t.get("tenant_id"),
                                        "project_id": t.get("project_id"),
                                        "timestamp": datetime.now(timezone.utc).isoformat(),
                                    })
                                elif old_status is None:
                                    self.bus.publish("task_transition", {
                                        "task_id": tid,
                                        "status": current_status,
                                        "previous_status": None,
                                        "action": "task_created",
                                        "title": t.get("title", ""),
                                        "tenant_id": t.get("tenant_id"),
                                        "project_id": t.get("project_id"),
                                        "timestamp": datetime.now(timezone.utc).isoformat(),
                                    })
                                self.task_statuses[tid] = current_status
                        except Exception:
                            pass
                        self.bus.publish("roadmap_sync", {
                            "action": "roadmap_updated",
                            "timestamp": datetime.now(timezone.utc).isoformat(),
                        })
                except OSError:
                    pass

            self.stopped.wait(self.interval)


_FOLLOWER: LogFollower | None = None
_FOLLOWER_LOCK = threading.Lock()


def start_log_follower(root: Path, bus: EventBus | None = None) -> LogFollower:
    global _FOLLOWER
    with _FOLLOWER_LOCK:
        if _FOLLOWER is None or not _FOLLOWER.is_alive():
            _FOLLOWER = LogFollower(root, bus=bus)
            _FOLLOWER.start()
        return _FOLLOWER


def stop_log_follower() -> None:
    global _FOLLOWER
    with _FOLLOWER_LOCK:
        if _FOLLOWER is not None:
            _FOLLOWER.stop()
            _FOLLOWER = None
