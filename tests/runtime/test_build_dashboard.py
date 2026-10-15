import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import build_dashboard
import build_events
import orchestrator
import roadmap_store
import webhook_server


class BuildDashboardTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.path = self.root / "ROADMAP.json"
        self.identity = {"tenantId": "tenant", "actorId": "actor"}
        self.task = {"id": "T-ISSUE-42-1", "title": "Task", "status": "pending",
                     "tenant_id": "tenant", "project_id": "project", "github_issue_number": 42}
        self.path.write_text(json.dumps({"tasks": [self.task], "current_task_id": None}))

    def test_stale_bot_snapshot_cannot_erase_a_dashboard_approval(self):
        stale = json.loads(self.path.read_text())
        revision = build_dashboard.revision(self.task)
        self.assertEqual(build_dashboard.approve(self.path, self.identity, "project", self.task["id"], revision), {})
        roadmap_store.save_roadmap(self.path, stale)
        saved = json.loads(self.path.read_text())["tasks"][0]
        self.assertEqual(saved["status"], "approved")
        self.assertEqual(saved["build_approval"]["actor_id"], "actor")

    def test_webhook_approval_and_closure_appear_in_the_scoped_feed(self):
        with patch.object(webhook_server, "PROJECT_ROOT", self.root), \
                patch.object(webhook_server, "ROADMAP_FILE", self.path), \
                patch.object(webhook_server.roadmap_sync, "sync_roadmap_to_github"), \
                patch.object(webhook_server.subprocess, "run") as command, \
                patch.object(webhook_server, "log"):
            command.return_value.returncode = 0
            self.assertTrue(webhook_server.mark_task_approved(42))
            self.assertEqual(build_dashboard.snapshot(self.path, self.identity, "project")["tasks"][0]["status"], "approved")
            webhook_server.handle_issue_closed(42, "2026-10-15T00:00:00Z")
        current = build_dashboard.snapshot(self.path, self.identity, "project")
        self.assertEqual(current["tasks"][0]["status"], "completed")
        self.assertEqual([row["source"] for row in current["logs"]], ["webhook", "webhook"])
        self.assertIn("closed", current["logs"][-1]["message"])
        self.assertEqual(build_dashboard.approve(self.path, self.identity, "project", self.task["id"], current["tasks"][0]["revision"]), {"error": 409})

    def test_orchestrator_activity_is_task_scoped(self):
        config = orchestrator.RuntimeConfig(project_root=self.root)
        orchestrator.log(config, "Private repository event")
        orchestrator.log(config, "Dispatching task", self.task["id"])
        logs = build_dashboard.snapshot(self.path, self.identity, "project")["logs"]
        self.assertEqual([row["message"] for row in logs], ["Dispatching task"])
        self.assertEqual(logs[0]["source"], "orchestrator")

    def test_tail_is_bounded_filters_other_tasks_and_ignores_partial_records(self):
        self.assertEqual(build_events.tail(self.root, {self.task["id"]}), [])
        for number in range(250):
            build_events.emit(self.root, self.task["id"], "orchestrator", str(number))
        build_events.emit(self.root, "other-task", "orchestrator", "private")
        with (self.root / "logs/build.jsonl").open("a") as output:
            output.write('{"partial":')
        logs = build_events.tail(self.root, {self.task["id"]})
        self.assertEqual(len(logs), 200)
        self.assertEqual(logs[0]["message"], "50")
        self.assertEqual(logs[-1]["message"], "249")
