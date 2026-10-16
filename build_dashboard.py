"""Trusted API bridge to the repository scheduler's atomic roadmap store."""
import hashlib
import json
import select
import sys
import threading
import urllib.parse
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from typing import Any, Generator

import build_events
import event_bus
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
        try:
            event_bus.publish("roadmap_sync", {
                "action": "budget_updated",
                "task_id": task_id,
                "tenant_id": identity.get("tenantId"),
                "project_id": project_id,
                "budget_cap_usd": cap,
                "timestamp": datetime.now(timezone.utc).isoformat(),
            })
        except Exception:
            pass
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
        try:
            event_bus.publish("task_transition", {
                "task_id": task_id,
                "status": "approved",
                "tenant_id": identity.get("tenantId"),
                "project_id": project_id,
                "timestamp": datetime.now(timezone.utc).isoformat(),
            })
        except Exception:
            pass
    return result


def stream_events(
    path: Path,
    identity: dict,
    project_id: str,
    bus: Any = None,
    ping_interval: float = 15.0,
    stop_event: threading.Event | None = None,
) -> Generator[dict, None, None]:
    """Yield live dashboard events (snapshot, task_transition, log, roadmap_sync) scoped to tenant/project."""
    bus = bus or event_bus.get_event_bus()
    try:
        event_bus.start_log_follower(path.parent, bus=bus)
    except Exception:
        pass

    # Initial snapshot
    initial_snapshot = snapshot(path, identity, project_id)
    yield {"type": "snapshot", "data": initial_snapshot}

    visible_task_ids = {t["id"] for t in initial_snapshot["tasks"]}

    def is_visible(event: dict) -> bool:
        etype = event.get("type")
        edata = event.get("data", {})
        if etype == "log":
            tid = edata.get("task_id")
            return tid in visible_task_ids if tid else False
        if etype == "task_transition":
            tid = edata.get("task_id")
            t_tenant = edata.get("tenant_id")
            t_proj = edata.get("project_id")
            if t_tenant and t_proj:
                return t_tenant == identity.get("tenantId") and t_proj == project_id
            return tid in visible_task_ids if tid else True
        if etype == "roadmap_sync":
            t_tenant = edata.get("tenant_id")
            t_proj = edata.get("project_id")
            if t_tenant and t_proj:
                return t_tenant == identity.get("tenantId") and t_proj == project_id
            return True
        return True

    subscriber = bus.subscribe_queue(
        event_types={"snapshot", "log", "task_transition", "roadmap_sync"},
        filter_fn=is_visible,
    )

    try:
        while not subscriber.closed and (not stop_event or not stop_event.is_set()):
            event = subscriber.get(timeout=ping_interval)
            if event is None:
                yield {"type": "ping", "data": {"timestamp": datetime.now(timezone.utc).isoformat()}, "is_ping": True}
                continue

            etype = event.get("type")
            yield event

            if etype in ("task_transition", "roadmap_sync"):
                try:
                    updated_snapshot = snapshot(path, identity, project_id)
                    visible_task_ids = {t["id"] for t in updated_snapshot["tasks"]}
                    yield {"type": "snapshot", "data": updated_snapshot}
                except Exception:
                    pass
    finally:
        subscriber.close()


def handle_dashboard_sse(
    handler,
    path: Path,
    identity: dict,
    project_id: str,
    bus: Any = None,
    ping_interval: float = 15.0,
    stop_event: threading.Event | None = None,
) -> None:
    handler.send_response(200)
    handler.send_header("Content-Type", "text/event-stream; charset=utf-8")
    handler.send_header("Cache-Control", "no-cache, no-transform")
    handler.send_header("Connection", "keep-alive")
    handler.send_header("Access-Control-Allow-Origin", "*")
    handler.send_header("Access-Control-Allow-Headers", "*")
    handler.end_headers()

    try:
        for event in stream_events(path, identity, project_id, bus=bus, ping_interval=ping_interval, stop_event=stop_event):
            if event.get("is_ping"):
                handler.wfile.write(event_bus.format_keepalive().encode("utf-8"))
            else:
                msg = event_bus.format_sse(event["type"], event["data"], event.get("id"))
                handler.wfile.write(msg.encode("utf-8"))
            handler.wfile.flush()
    except (BrokenPipeError, ConnectionResetError, OSError):
        pass


def handle_dashboard_websocket(
    handler,
    path: Path,
    identity: dict,
    project_id: str,
    bus: Any = None,
    ping_interval: float = 20.0,
    stop_event: threading.Event | None = None,
) -> None:
    key = handler.headers.get("Sec-WebSocket-Key")
    if not key:
        handler.send_error(400, "Missing Sec-WebSocket-Key")
        return

    accept = event_bus.compute_websocket_accept(key)
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

        for event in stream_events(path, identity, project_id, bus=bus, ping_interval=ping_interval, stop_event=stop_event):
            if raw_sock is not None:
                try:
                    readable, _, _ = select.select([raw_sock], [], [], 0.05)
                except Exception:
                    readable = False
                if readable:
                    try:
                        res = event_bus.decode_websocket_frame(handler.rfile)
                        if res is None:
                            break
                        opcode, payload = res
                        if opcode == 0x8:  # Close
                            try:
                                handler.wfile.write(event_bus.encode_websocket_frame(payload, opcode=0x8))
                                handler.wfile.flush()
                            except Exception:
                                pass
                            break
                        elif opcode == 0x9:  # Ping -> Pong
                            handler.wfile.write(event_bus.encode_websocket_frame(payload, opcode=0xA))
                            handler.wfile.flush()
                    except (TimeoutError, OSError):
                        break

            if event.get("is_ping"):
                handler.wfile.write(event_bus.encode_websocket_frame(b"", opcode=0x9))
                handler.wfile.flush()
                continue

            payload = json.dumps({
                "event": event["type"],
                "data": event["data"],
                "id": event.get("id"),
                "timestamp": datetime.now(timezone.utc).isoformat(),
            })
            handler.wfile.write(event_bus.encode_websocket_frame(payload))
            handler.wfile.flush()
    except (BrokenPipeError, ConnectionResetError, OSError):
        pass


class BuildDashboardHandler(BaseHTTPRequestHandler):
    roadmap_path: Path = Path("/root/projects/software-factory/ROADMAP.json")

    def _get_identity_and_project(self) -> tuple[dict, str]:
        parsed = urllib.parse.urlparse(self.path)
        query = urllib.parse.parse_qs(parsed.query)
        tenant_id = self.headers.get("x-tenant-id") or query.get("tenantId", query.get("tenant_id", ["default"]))[0]
        actor_id = self.headers.get("x-actor-id") or query.get("actorId", query.get("actor_id", ["default"]))[0]
        project_id = query.get("projectId", query.get("project_id", [None]))[0]
        if not project_id:
            parts = [p for p in parsed.path.split("/") if p]
            if "projects" in parts:
                idx = parts.index("projects")
                if idx + 1 < len(parts):
                    project_id = parts[idx + 1]
        return {"tenantId": tenant_id, "actorId": actor_id}, project_id or "default"

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        identity, project_id = self._get_identity_and_project()

        is_websocket = (
            path.endswith("/ws") or
            self.headers.get("Upgrade", "").lower() == "websocket"
        )
        is_sse = (
            path.endswith("/stream") or
            path.endswith("/events") or
            "text/event-stream" in self.headers.get("Accept", "")
        )

        if is_websocket:
            handle_dashboard_websocket(self, self.roadmap_path, identity, project_id)
            return
        if is_sse:
            handle_dashboard_sse(self, self.roadmap_path, identity, project_id)
            return

        snap = snapshot(self.roadmap_path, identity, project_id)
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(json.dumps(snap).encode("utf-8"))

    def do_POST(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        identity, project_id = self._get_identity_and_project()
        content_length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(content_length).decode("utf-8") if content_length > 0 else "{}"
        try:
            payload = json.loads(body)
        except Exception:
            payload = {}

        if "/approve" in path:
            parts = [p for p in path.split("/") if p]
            task_id = None
            if "tasks" in parts:
                idx = parts.index("tasks")
                if idx + 1 < len(parts):
                    task_id = parts[idx + 1]
            if not task_id:
                task_id = payload.get("taskId", payload.get("task_id"))
            revision = payload.get("revision", "")
            if not task_id:
                self.send_error(400, "Missing taskId")
                return
            res = approve(self.roadmap_path, identity, project_id, task_id, revision)
            status_code = 200
            if "error" in res:
                status_code = res["error"]
                snap = res
            else:
                snap = snapshot(self.roadmap_path, identity, project_id)
            self.send_response(status_code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(json.dumps(snap).encode("utf-8"))
            return

        self.send_error(404, "Not Found")

    def do_PATCH(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        identity, project_id = self._get_identity_and_project()
        content_length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(content_length).decode("utf-8") if content_length > 0 else "{}"
        try:
            payload = json.loads(body)
        except Exception:
            payload = {}

        if "/budget" in path:
            parts = [p for p in path.split("/") if p]
            task_id = None
            if "tasks" in parts:
                idx = parts.index("tasks")
                if idx + 1 < len(parts):
                    task_id = parts[idx + 1]
            if not task_id:
                task_id = payload.get("taskId", payload.get("task_id"))
            revision = payload.get("revision", "")
            cap = payload.get("budget_cap_usd")
            if not task_id:
                self.send_error(400, "Missing taskId")
                return
            res = set_budget(self.roadmap_path, identity, project_id, task_id, revision, cap)
            status_code = 200
            if "error" in res:
                status_code = res["error"]
                snap = res
            else:
                snap = snapshot(self.roadmap_path, identity, project_id)
            self.send_response(status_code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(json.dumps(snap).encode("utf-8"))
            return

        self.send_error(404, "Not Found")

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, PATCH, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "*")
        self.end_headers()

    def log_message(self, format, *args):
        pass


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] in ("--serve", "serve"):
        port = int(sys.argv[2]) if len(sys.argv) > 2 else 9098
        roadmap_path = Path(sys.argv[3]) if len(sys.argv) > 3 else Path("/root/projects/software-factory/ROADMAP.json")
        BuildDashboardHandler.roadmap_path = roadmap_path
        server = HTTPServer(("127.0.0.1", port), BuildDashboardHandler)
        print(f"Build Dashboard Server running on 127.0.0.1:{port}", flush=True)
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass
        server.server_close()
        sys.exit(0)

    path = Path(sys.argv[1])
    request = json.load(sys.stdin)
    if request.get("operation") == "stream":
        for event in stream_events(path, request["identity"], request["projectId"]):
            if event.get("is_ping"):
                sys.stdout.write(event_bus.format_keepalive())
            else:
                sys.stdout.write(event_bus.format_sse(event["type"], event["data"], event.get("id")))
            sys.stdout.flush()
        sys.exit(0)

    result = {}
    if request["operation"] == "approve":
        result = approve(path, request["identity"], request["projectId"], request["taskId"], request["revision"])
    if request["operation"] == "budget":
        result = set_budget(path, request["identity"], request["projectId"], request["taskId"],
                            request["revision"], request["budget_cap_usd"])
    if "error" not in result:
        result = snapshot(path, request["identity"], request["projectId"])
    print(json.dumps(result))
