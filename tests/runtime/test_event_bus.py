import base64
import http.client
import json
from pathlib import Path
import queue
import socket
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

import build_dashboard
import build_events
import webhook_server


class EventBusTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.roadmap_file = self.root / "ROADMAP.json"
        self.task = {
            "id": "T-TEST-1",
            "title": "Test Task",
            "status": "pending",
            "tenant_id": "tenant-1",
            "project_id": "proj-1",
            "github_issue_number": 101,
        }
        self.roadmap_file.write_text(json.dumps({"tasks": [self.task], "current_task_id": None}))
        self.bus = build_dashboard.StreamingEventBus(project_root=self.root)
        self.addCleanup(self.bus.close)

    def test_event_bus_publish_and_subscribe(self):
        # 1. Unfiltered subscription
        q_all = self.bus.subscribe()
        # 2. Filtered by event type
        q_trans = self.bus.subscribe(event_types={"task_transition"})
        # 3. Filtered by task ID
        q_task = self.bus.subscribe(task_ids={"T-TEST-1"})

        # Publish a task transition for T-TEST-1
        evt1 = self.bus.publish_task_transition(
            task_id="T-TEST-1",
            status="in_progress",
            previous_status="pending",
            github_issue_number=101,
        )
        self.assertEqual(evt1.type, "task_transition")
        self.assertEqual(evt1.task_id, "T-TEST-1")

        rec1_all = q_all.get(timeout=1.0)
        rec1_trans = q_trans.get(timeout=1.0)
        rec1_task = q_task.get(timeout=1.0)
        self.assertEqual(rec1_all.id, evt1.id)
        self.assertEqual(rec1_trans.id, evt1.id)
        self.assertEqual(rec1_task.id, evt1.id)

        # Publish a console log for a different task
        evt2 = self.bus.publish_console_log(
            task_id="T-TEST-2",
            source="orchestrator",
            message="Processing T-TEST-2",
        )
        rec2_all = q_all.get(timeout=1.0)
        self.assertEqual(rec2_all.id, evt2.id)

        # q_trans should NOT receive console_log
        self.assertTrue(q_trans.empty())
        # q_task should NOT receive events for T-TEST-2
        self.assertTrue(q_task.empty())

        # Unsubscribe
        self.bus.unsubscribe(q_all)
        self.bus.publish("ping", {"message": "hello"})
        self.assertTrue(q_all.empty())

    def test_event_bus_build_events_integration(self):
        q = self.bus.subscribe(event_types={"console_log"})
        # Call build_events.emit
        record = build_events.emit(self.root, "T-TEST-1", "orchestrator", "Compiling assets...")
        evt = q.get(timeout=1.0)
        self.assertEqual(evt.type, "console_log")
        self.assertEqual(evt.task_id, "T-TEST-1")
        self.assertEqual(evt.data["message"], "Compiling assets...")
        self.assertEqual(evt.data["source"], "orchestrator")

    def test_event_bus_file_watcher_tailing(self):
        self.bus.start_file_watcher(self.root, poll_interval=0.1)

        q = self.bus.subscribe()

        # Append directly to build.jsonl to simulate a separate process writing
        log_file = self.root / "logs" / "build.jsonl"
        log_file.parent.mkdir(exist_ok=True)
        external_record = {
            "id": "ext-1",
            "task_id": "T-TEST-1",
            "source": "claude",
            "timestamp": "2026-10-17T00:00:00Z",
            "message": "Agent execution starting",
        }
        with log_file.open("a", encoding="utf-8") as f:
            f.write(json.dumps(external_record) + "\n")

        # Wait for file watcher to pick it up
        found = False
        start = time.time()
        while time.time() - start < 3.0:
            try:
                evt = q.get(timeout=0.5)
                if evt.type == "console_log" and evt.data.get("id") == "ext-1":
                    found = True
                    break
            except queue.Empty:
                pass
        self.assertTrue(found, "File watcher should have streamed appended log line")

        # Now simulate an external process updating ROADMAP.json
        roadmap_data = json.loads(self.roadmap_file.read_text(encoding="utf-8"))
        roadmap_data["tasks"][0]["status"] = "in_progress"
        self.roadmap_file.write_text(json.dumps(roadmap_data))

        found_transition = False
        start = time.time()
        while time.time() - start < 3.0:
            try:
                evt = q.get(timeout=0.5)
                if evt.type == "task_transition" and evt.task_id == "T-TEST-1" and evt.data.get("status") == "in_progress":
                    found_transition = True
                    break
            except queue.Empty:
                pass
        self.assertTrue(found_transition, "File watcher should have streamed task transition from ROADMAP.json")

    def test_websocket_framing_and_handshake(self):
        # 1. Accept key calculation per RFC 6455
        test_key = "dGhlIHNhbXBsZSBub25jZQ=="
        accept = build_dashboard.make_ws_accept(test_key)
        self.assertEqual(accept, "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=")

        # 2. Text frame encoding & unmasked decoding
        msg = "Hello Real-Time Event Bus!"
        frame = build_dashboard.encode_ws_frame(msg, opcode=0x01)
        opcode, payload, rem = build_dashboard.decode_ws_frame(frame)
        self.assertEqual(opcode, 0x01)
        self.assertEqual(payload.decode("utf-8"), msg)
        self.assertEqual(len(rem), 0)

        # 3. Medium length frame (> 125 bytes)
        long_msg = "X" * 300
        frame_long = build_dashboard.encode_ws_frame(long_msg, opcode=0x01)
        opcode_l, payload_l, rem_l = build_dashboard.decode_ws_frame(frame_long)
        self.assertEqual(opcode_l, 0x01)
        self.assertEqual(payload_l.decode("utf-8"), long_msg)

        # 4. Masked frame decoding (client to server)
        raw_bytes = msg.encode("utf-8")
        mask = b"\x12\x34\x56\x78"
        masked_payload = bytes(b ^ mask[i % 4] for i, b in enumerate(raw_bytes))
        masked_frame = bytearray([0x81, 0x80 | len(raw_bytes)]) + mask + masked_payload
        opcode_m, payload_m, _ = build_dashboard.decode_ws_frame(bytes(masked_frame))
        self.assertEqual(opcode_m, 0x01)
        self.assertEqual(payload_m.decode("utf-8"), msg)

    def test_stream_dashboard_events_generator(self):
        identity = {"tenantId": "tenant-1", "actorId": "actor-1"}
        generator = build_dashboard.stream_dashboard_events(
            self.roadmap_file,
            identity,
            "proj-1",
            event_bus=self.bus,
            heartbeat_interval=0.2,
            max_events=3,
        )

        # Event 1: Initial snapshot
        first = next(generator)
        self.assertIn("event: snapshot", first)
        self.assertIn("T-TEST-1", first)

        # Produce an event
        self.bus.publish_task_transition("T-TEST-1", "in_progress")

        # Event 2: Task transition
        second = next(generator)
        self.assertIn("event: task_transition", second)
        self.assertIn('"status": "in_progress"', second)


class WebhookServerStreamingTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temporary = tempfile.TemporaryDirectory()
        cls.root = Path(cls.temporary.name)
        cls.roadmap_file = cls.root / "ROADMAP.json"
        cls.task = {
            "id": "T-WEB-1",
            "title": "Webhook Task",
            "status": "pending",
            "tenant_id": "tenant-1",
            "project_id": "proj-1",
            "github_issue_number": 202,
        }
        cls.roadmap_file.write_text(json.dumps({"tasks": [cls.task], "current_task_id": None}))

        # Bind to ephemeral port
        server_address = ("127.0.0.1", 0)
        cls.httpd = webhook_server.ThreadingHTTPServer(server_address, webhook_server.GitHubWebhookHandler)
        cls.port = cls.httpd.server_address[1]

        cls.bus = build_dashboard.get_event_bus(cls.root)
        cls.patches = [
            patch.object(webhook_server, "PROJECT_ROOT", cls.root),
            patch.object(webhook_server, "ROADMAP_FILE", cls.roadmap_file),
            patch.object(webhook_server.roadmap_sync, "sync_roadmap_to_github"),
            patch.object(webhook_server.subprocess, "run"),
            patch.object(webhook_server, "log"),
        ]
        for p in cls.patches:
            p.start()

        cls.server_thread = threading.Thread(target=cls.httpd.serve_forever, daemon=True)
        cls.server_thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.httpd._shutdown_requested = True
        cls.httpd.shutdown()
        cls.httpd.server_close()
        for p in cls.patches:
            p.stop()
        cls.temporary.cleanup()

    def test_sse_endpoint_streams_events(self):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5.0)
        conn.request("GET", "/events")
        resp = conn.getresponse()
        self.assertEqual(resp.status, 200)
        self.assertIn("text/event-stream", resp.getheader("Content-Type", ""))

        # Read initial connected event
        line1 = resp.fp.readline().decode("utf-8")
        line2 = resp.fp.readline().decode("utf-8")
        line3 = resp.fp.readline().decode("utf-8")
        data_text = line1 + line2 + line3
        self.assertIn("event: connected", data_text)

        # Trigger a task transition via POST /task/transition
        post_conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5.0)
        post_conn.request(
            "POST",
            "/task/transition",
            json.dumps({"task_id": "T-WEB-1", "status": "in_progress", "commit_sha": "abc1234"}),
            headers={"Content-Type": "application/json"},
        )
        post_resp = post_conn.getresponse()
        self.assertEqual(post_resp.status, 200)
        post_conn.close()

        # Read event from SSE stream
        stream_lines = []
        for _ in range(6):
            l = resp.fp.readline().decode("utf-8")
            if l.strip():
                stream_lines.append(l)
            if len(stream_lines) >= 3:
                break
        combined = "".join(stream_lines)
        self.assertIn("event: task_transition", combined)
        self.assertIn("in_progress", combined)

        conn.close()

    def test_websocket_endpoint_streams_events(self):
        sock = socket.create_connection(("127.0.0.1", self.port), timeout=5.0)
        sec_key = base64.b64encode(b"0123456789abcdef").decode("utf-8")
        request = (
            f"GET /ws HTTP/1.1\r\n"
            f"Host: 127.0.0.1:{self.port}\r\n"
            f"Upgrade: websocket\r\n"
            f"Connection: Upgrade\r\n"
            f"Sec-WebSocket-Key: {sec_key}\r\n"
            f"Sec-WebSocket-Version: 13\r\n\r\n"
        )
        sock.sendall(request.encode("utf-8"))

        # Read HTTP 101 Switching Protocols response headers
        headers_data = b""
        while b"\r\n\r\n" not in headers_data:
            chunk = sock.recv(1024)
            if not chunk:
                break
            headers_data += chunk
        header_bytes, _, frame_data = headers_data.partition(b"\r\n\r\n")
        header_text = header_bytes.decode("utf-8", errors="replace")
        self.assertIn("101 Switching Protocols", header_text)
        expected_accept = build_dashboard.make_ws_accept(sec_key)
        self.assertIn(expected_accept, header_text)

        # Read initial connected frame
        while True:
            opcode, payload, rem = build_dashboard.decode_ws_frame(frame_data)
            if opcode is not None:
                break
            chunk = sock.recv(1024)
            if not chunk:
                break
            frame_data += chunk
        self.assertEqual(opcode, 0x01)
        self.assertIsNotNone(payload)
        self.assertIn("connected", payload.decode("utf-8"))

        # Publish an event to the bus
        self.bus.publish_console_log("T-WEB-1", "orchestrator", "Task started executing")

        # Read WebSocket frame with event
        event_frame = rem
        while True:
            opcode2, payload2, rem2 = build_dashboard.decode_ws_frame(event_frame)
            if opcode2 is not None:
                break
            chunk = sock.recv(1024)
            if not chunk:
                break
            event_frame += chunk
        self.assertEqual(opcode2, 0x01)
        self.assertIsNotNone(payload2)
        self.assertIn("Task started executing", payload2.decode("utf-8"))

        # Send close frame
        close_frame = bytearray([0x88, 0x80]) + b"\x00\x00\x00\x00"
        try:
            sock.sendall(close_frame)
        except OSError:
            pass
        sock.close()

    def test_nonblocking_webhook_requests_while_streaming(self):
        # Open an SSE connection that stays connected
        sse_conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5.0)
        sse_conn.request("GET", "/events")
        sse_resp = sse_conn.getresponse()
        self.assertEqual(sse_resp.status, 200)

        # While SSE is open, POST request must be processed concurrently without blocking
        post_conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5.0)
        start = time.time()
        post_conn.request(
            "POST",
            "/events/publish",
            json.dumps({"type": "test_event", "data": {"key": "value"}}),
            headers={"Content-Type": "application/json"},
        )
        post_resp = post_conn.getresponse()
        elapsed = time.time() - start
        self.assertEqual(post_resp.status, 200)
        self.assertLess(elapsed, 1.0, "Webhook request should respond immediately despite active SSE stream")
        post_conn.close()
        sse_conn.close()


if __name__ == "__main__":
    unittest.main()
