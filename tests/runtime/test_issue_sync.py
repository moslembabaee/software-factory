"""Exercise issue synchronization with durable roadmap files and a fake GitHub API."""
import copy
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import issue_bot
import issue_lifecycle
import issue_sync
import roadmap_store
import webhook_server


class GitHub:
    def __init__(self):
        self.calls = []
        self.comments = {}
        self.closed = set()
        self.fail = None

    def __call__(self, argv, **kwargs):
        self.calls.append(argv)
        if self.fail and argv[:len(self.fail)] == self.fail:
            return 1, "GitHub unavailable"
        if argv[:2] == ["gh", "api"]:
            number = int(argv[-1].split('/issues/')[1].split('/')[0])
            # Nested pages exercise --paginate --slurp comment recovery.
            return 0, json.dumps([[{"body": "unrelated"}], self.comments.get(number, [])])
        number = int(argv[3])
        if argv[2] == "comment":
            self.comments.setdefault(number, []).append({"body": argv[-1]})
        if argv[2] == "close":
            self.closed.add(number)
        return 0, ""

    def commands(self, command):
        return [call for call in self.calls if call[:3] == ["gh", "issue", command]]


class IssueSyncTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        self.path = self.root / "ROADMAP.json"
        self.path.write_text(json.dumps({"tasks": [], "current_task_id": None}))
        self.github = GitHub()
        self.issue = {"id": 1400, "number": 14, "title": "Sync issues", "body": "Implementation scope",
                      "state": "open", "labels": [{"name": "factory/task"}, {"name": "phase/custom"}],
                      "assignee": {"login": "codex"}, "updated_at": "2026-10-16T14:00:00Z"}
        for name, value in (("PROJECT_ROOT", self.root), ("ROADMAP_FILE", self.path)):
            self.enterContext(patch.object(webhook_server, name, value))
        self.enterContext(patch.object(webhook_server.roadmap_sync, "sync_roadmap_to_github"))
        self.enterContext(patch.object(webhook_server, "log"))
        self.enterContext(patch.object(issue_bot, "log"))
        self.enterContext(patch.object(webhook_server, "load_label_config", return_value={
            "phases": {"phase/custom": "Custom phase"}}))

    def data(self):
        return json.loads(self.path.read_text())

    def task(self):
        return self.data()["tasks"][0]

    def change(self, **values):
        def apply(data):
            data["tasks"][0].update(values)
            return True
        roadmap_store.update_roadmap(self.path, apply)

    def deliver(self, action="labeled", label="factory/task", delivery="delivery-1"):
        return webhook_server.reconcile_github_issue(
            copy.deepcopy(self.issue), {"action": action, "label": {"name": label}},
            runner=self.github, headers={"X-GitHub-Event": "issues", "X-GitHub-Delivery": delivery})

    def post(self, action, label="factory/task"):
        payload = {"action": action, "issue": copy.deepcopy(self.issue), "label": {"name": label}}
        body = json.dumps(payload).encode()
        handler = object.__new__(webhook_server.GitHubWebhookHandler)
        handler.path = "/webhook"
        handler.headers = {"Content-Length": str(len(body)), "X-GitHub-Event": "issues",
                           "X-GitHub-Delivery": "http-delivery"}
        handler.rfile, handler.wfile = io.BytesIO(body), io.BytesIO()
        responses = []
        handler.send_response = responses.append
        handler.send_header = lambda *args: None
        handler.end_headers = lambda: None
        with patch.object(webhook_server.subprocess, "run", side_effect=lambda argv, **kw: self.github(argv)):
            # run_gh's transport receives a CompletedProcess in production.
            with patch.object(webhook_server, "run_gh", side_effect=lambda argv, **kw: self.github(argv)):
                handler.do_POST()
        return responses[-1], json.loads(handler.wfile.getvalue())

    def test_create_and_replay_are_durable_and_bidirectional(self):
        self.assertTrue(self.deliver())
        task = self.task()
        self.assertEqual((task["id"], task["phase"], task["assignee"], task["assigned_agent"]),
                         ("T-ISSUE-14", "Custom phase", "codex", "codex"))
        self.assertEqual((task["github_issue_number"], task["github_issue_id"]), (14, 1400))
        self.assertIn("factory-task-id: T-ISSUE-14", self.github.comments[14][0]["body"])
        before = self.path.read_bytes()
        self.assertTrue(self.deliver(delivery="redelivery-new-id"))
        self.assertEqual(self.path.read_bytes(), before)
        self.assertEqual(len(self.github.commands("comment")), 1)
        record = task["history"][0]
        self.assertEqual((record["github_action"], record["issue_id"], record["event_timestamp"]),
                         ("labeled", 1400, self.issue["updated_at"]))
        self.assertEqual(record["delivery_id"], "delivery-1")
        self.assertIn(record, self.data()["history"])

    def test_edits_phase_labels_and_assignee_removal_reconcile(self):
        self.deliver()
        self.issue.update(title="Changed", body="Updated scope", assignee=None, assignees=[],
                          updated_at="2026-10-16T14:01:00Z")
        self.issue["labels"] = [{"name": "factory/task"}, {"name": "phase/2"}]
        self.assertEqual(self.post("unassigned")[0], 200)
        self.assertEqual(self.task()["title"], "Issue #14: Changed")
        self.assertIn("Updated scope", self.task()["description"])
        self.assertIsNone(self.task()["assignee"])
        self.assertEqual(self.task()["phase"], "Phase 2: Queue + Sandbox")
        self.issue["updated_at"] = "2026-10-16T14:02:00Z"
        self.issue["labels"].append({"name": "phase/custom"})
        self.assertEqual(self.post("labeled", "phase/custom")[0], 200)
        self.assertEqual(self.task()["phase"], "Custom phase")
        self.assertEqual(self.task()["history"][-1]["github_action"], "labeled")

    def test_same_second_distinct_actions_are_not_lost(self):
        self.deliver()
        self.issue["labels"] = []
        self.assertTrue(self.deliver("unlabeled"))
        self.assertEqual(self.task()["status"], "paused")
        self.assertEqual(len(self.data()["github_sync_events"]), 2)

    def test_unlink_and_relink_preserve_task_identity(self):
        self.deliver()
        self.change(status="in_progress")
        roadmap_store.update_roadmap(self.path, lambda data: data.update(current_task_id="T-ISSUE-14") or True)
        self.issue["updated_at"] = "2026-10-16T14:01:00Z"
        self.issue["labels"] = []
        self.assertTrue(self.deliver("unlabeled"))
        self.assertTrue(self.task()["unlinked"])
        self.assertIsNone(self.task()["github_issue_number"])
        self.assertIsNone(self.data()["current_task_id"])
        self.issue["updated_at"] = "2026-10-16T14:02:00Z"
        self.issue["labels"] = [{"name": "factory/task"}]
        self.assertTrue(self.deliver())
        self.assertEqual(len(self.data()["tasks"]), 1)
        self.assertEqual(self.task()["status"], "approved")
        self.assertNotIn("unlinked", self.task())
        self.assertEqual(len(self.github.commands("comment")), 1)

    def test_done_task_is_unlinked_without_pausing(self):
        self.deliver()
        self.change(status="done")
        self.issue["updated_at"] = "2026-10-16T14:01:00Z"
        self.assertTrue(self.deliver("unlabeled"))
        self.assertEqual(self.task()["status"], "done")
        self.assertTrue(self.task()["unlinked"])
        self.assertFalse(webhook_server.handle_task_transition("T-ISSUE-14", "done", runner=self.github))
        self.assertFalse(self.github.closed)

    def test_old_event_cannot_undo_newer_snapshot(self):
        self.deliver()
        old_issue = copy.deepcopy(self.issue)
        self.issue.update(title="Newer title", updated_at="2026-10-16T14:02:00Z")
        self.deliver("edited")
        self.issue = old_issue
        self.deliver("unlabeled")
        self.assertEqual(self.task()["title"], "Issue #14: Newer title")
        self.assertNotIn("unlinked", self.task())

    def test_comment_failure_does_not_acknowledge_webhook(self):
        self.github.fail = ["gh", "issue", "comment"]
        self.assertEqual(self.post("labeled")[0], 503)
        self.assertEqual(len(self.data()["tasks"]), 1)
        self.assertEqual(self.data()["github_sync_events"], [])
        self.assertNotIn("github_link_notified", self.task())
        self.github.fail = None
        self.assertEqual(self.post("labeled")[0], 200)
        self.assertEqual(len(self.data()["tasks"]), 1)
        self.assertTrue(self.task()["github_link_notified"])

    def test_crash_after_remote_comment_recovers_without_duplicate(self):
        self.github.comments[14] = [{"body": "<!-- factory-task-id: T-ISSUE-14 -->"}]
        self.assertTrue(self.deliver())
        self.assertFalse(self.github.commands("comment"))
        self.assertTrue(self.task()["github_link_notified"])

    def test_body_task_id_links_existing_proposal(self):
        self.path.write_text(json.dumps({"tasks": [{"id": "T-PROPOSAL", "status": "pending"}]}))
        self.issue["body"] = "**Task ID:** `T-PROPOSAL`\nRequirements"
        self.deliver()
        self.assertEqual(len(self.data()["tasks"]), 1)
        self.assertEqual(self.task()["id"], "T-PROPOSAL")
        self.assertEqual(self.task()["github_issue_number"], 14)

    def test_issue_marker_cannot_steal_another_issues_task(self):
        self.path.write_text(json.dumps({"tasks": [{"id": "T-OTHER", "status": "approved", "github_issue_number": 99}]}))
        self.issue["body"] = "<!-- factory-task-id: T-OTHER -->"
        self.deliver()
        self.assertEqual(len(self.data()["tasks"]), 2)
        self.assertEqual(self.task()["id"], "T-ISSUE-14")
        self.assertEqual(self.data()["tasks"][1]["github_issue_number"], 99)

    def test_legacy_tasks_are_not_paused_for_missing_factory_label(self):
        self.path.write_text(json.dumps({"tasks": [{"id": "T-ISSUE-14", "status": "approved"}]}))
        self.issue["labels"] = []
        self.deliver("edited")
        self.assertEqual(self.task()["status"], "approved")
        self.assertNotIn("unlinked", self.task())

    def test_verified_and_done_results_close_once_and_include_references(self):
        for status in ("verified", "done", "completed"):
            with self.subTest(status=status):
                self.path.write_text(json.dumps({"tasks": []}))
                self.github = GitHub()
                self.deliver()
                self.change(status=status, commit_sha="abc123", pr_number=88,
                            verifications=[{"exit_code": 0, "command": "npm test"}])
                self.assertTrue(webhook_server.handle_task_transition("T-ISSUE-14", status, runner=self.github))
                comment = self.github.comments[14][-1]["body"]
                self.assertIn("abc123", comment)
                self.assertIn("#88", comment)
                self.assertIn("npm test", comment)
                self.assertIn(14, self.github.closed)
                self.assertEqual(webhook_server.sync_tasks_to_issues(runner=self.github), 0)
                self.change(status="completed")
                self.assertEqual(webhook_server.sync_tasks_to_issues(runner=self.github), 0)
                self.assertEqual(len(self.github.commands("close")), 1)

    def test_result_comment_failure_is_retryable(self):
        self.deliver()
        self.change(status="done")
        self.github.fail = ["gh", "issue", "comment"]
        self.assertFalse(webhook_server.handle_task_transition("T-ISSUE-14", "done", runner=self.github))
        self.assertNotIn("notified_done", self.task())
        self.assertNotIn("closed_at", self.task())
        self.assertFalse(self.github.closed)
        self.github.fail = None
        self.assertEqual(webhook_server.sync_tasks_to_issues(runner=self.github), 1)

    def test_close_failure_retries_without_reposting_result(self):
        self.deliver()
        self.change(status="done")
        self.github.fail = ["gh", "issue", "close"]
        self.assertFalse(webhook_server.handle_task_transition("T-ISSUE-14", "done", runner=self.github))
        self.assertTrue(self.task()["github_result_commented"])
        self.assertNotIn("notified_done", self.task())
        self.assertNotIn("closed_at", self.task())
        self.github.fail = None
        self.assertEqual(webhook_server.sync_tasks_to_issues(runner=self.github), 1)
        self.assertEqual(len(self.github.commands("comment")), 2)  # Link and result.

    def test_task_notification_cannot_invent_a_transition(self):
        self.deliver()
        self.assertFalse(webhook_server.handle_task_transition("T-ISSUE-14", "done", runner=self.github))
        self.assertEqual(self.task()["status"], "approved")
        self.assertFalse(self.github.closed)
        self.change(status="done")
        self.assertFalse(webhook_server.handle_task_transition("", "done", runner=self.github))
        self.assertFalse(webhook_server.handle_task_transition("T-ISSUE-14", "", runner=self.github))
        self.assertFalse(self.github.closed)

    def test_parent_stays_open_until_all_subtasks_are_ready(self):
        tasks = [{"id": f"T-ISSUE-14-{i}", "github_issue_number": 14, "factory_issue_sync": True,
                  "total_subtasks": 2, "title": f"Part {i}", "description": f"Scope {i}", "status": status}
                 for i, status in ((1, "done"), (2, "in_progress"))]
        self.path.write_text(json.dumps({"tasks": tasks}))
        self.assertEqual(webhook_server.sync_tasks_to_issues(runner=self.github), 1)
        self.assertFalse(self.github.closed)
        self.assertIn("remaining", self.github.comments[14][0]["body"])
        roadmap_store.update_roadmap(self.path, lambda data: data["tasks"][1].update(status="verified") or True)
        self.assertEqual(webhook_server.sync_tasks_to_issues(runner=self.github), 1)
        self.assertIn(14, self.github.closed)

    def test_closed_webhook_logs_source_and_is_idempotent(self):
        self.deliver()
        self.issue.update(state="closed", closed_at="2026-10-16T14:01:00Z", updated_at="2026-10-16T14:01:00Z")
        self.assertEqual(self.post("closed")[0], 200)
        self.assertEqual(self.task()["status"], "completed")
        self.assertEqual(self.task()["history"][-1]["event_timestamp"], self.issue["updated_at"])
        before = self.path.read_bytes()
        self.assertEqual(self.post("closed")[0], 200)
        self.assertEqual(before, self.path.read_bytes())

    def test_polling_reconciles_edits_unlink_and_relink(self):
        def poll():
            with patch.object(issue_bot, "ROADMAP_FILE", self.path), \
                    patch.object(issue_bot, "load_maintainers", return_value={}), \
                    patch.object(issue_bot, "sync_closed_issues", return_value=False), \
                    patch.object(issue_bot, "fetch_open_issues", return_value=[copy.deepcopy(self.issue)]), \
                    patch.object(issue_bot, "run_cmd", side_effect=self.github):
                issue_bot.process_issues()
        # Polling JSON uses camel-case GitHub CLI timestamps.
        self.issue["updatedAt"] = self.issue.pop("updated_at")
        poll()
        self.assertEqual(self.task()["id"], "T-ISSUE-14")
        self.issue.update(body="Changed by poll", updatedAt="2026-10-16T14:01:00Z")
        poll()
        self.assertIn("Changed by poll", self.task()["description"])
        self.issue["labels"] = []
        self.issue["updatedAt"] = "2026-10-16T14:02:00Z"
        poll()
        self.assertTrue(self.task()["unlinked"])
        self.issue["labels"] = [{"name": "factory/task"}]
        self.issue["updatedAt"] = "2026-10-16T14:03:00Z"
        poll()
        self.assertEqual(len(self.data()["tasks"]), 1)
        self.assertNotIn("unlinked", self.task())
        before = self.path.read_bytes()
        poll()
        self.assertEqual(before, self.path.read_bytes())

    def test_stale_snapshot_cannot_erase_sync_history_or_link(self):
        self.deliver()
        stale = self.data()
        self.issue.update(title="Newer title", updated_at="2026-10-16T14:01:00Z")
        self.deliver("edited")
        latest = self.data()
        roadmap_store.save_roadmap(self.path, stale)
        self.assertEqual(self.data(), latest)

    def test_dedupe_does_not_collapse_distinct_comments(self):
        payload = {"issue": self.issue, "action": "created", "comment": {
            "id": 1, "created_at": "2026-10-16T14:00:00Z"}}
        first = issue_lifecycle.get_webhook_dedupe_key(payload)
        payload["comment"]["id"] = 2
        self.assertNotEqual(first, issue_lifecycle.get_webhook_dedupe_key(payload))

    def test_concurrent_webhook_deliveries_create_one_task_and_comment(self):
        from concurrent.futures import ThreadPoolExecutor
        with ThreadPoolExecutor(max_workers=4) as pool:
            results = list(pool.map(lambda n: self.deliver(delivery=f"delivery-{n}"), range(8)))
        self.assertTrue(all(results))
        self.assertEqual(len(self.data()["tasks"]), 1)
        self.assertEqual(len(self.github.commands("comment")), 1)
        self.assertEqual(len(self.data()["github_sync_events"]), 1)

    def test_polling_delivers_a_verified_result_without_an_explicit_notification(self):
        self.deliver()
        self.change(status="verified")
        with patch.object(issue_bot, "ROADMAP_FILE", self.path), \
                patch.object(issue_bot, "load_maintainers", return_value={}), \
                patch.object(issue_bot, "sync_closed_issues", return_value=False), \
                patch.object(issue_bot, "fetch_open_issues", return_value=[]), \
                patch.object(issue_bot, "run_cmd", side_effect=self.github):
            issue_bot.process_issues()
            issue_bot.process_issues()
        self.assertIn(14, self.github.closed)
        self.assertTrue(self.task()["notified_verified"])
        self.assertEqual(len(self.github.commands("close")), 1)

    def test_existing_notification_flags_are_respected(self):
        self.deliver()
        self.change(status="completed", notified_completed=True)
        before = len(self.github.calls)
        self.assertEqual(webhook_server.sync_tasks_to_issues(runner=self.github), 0)
        self.assertEqual(len(self.github.calls), before)

    def test_completed_subtasks_close_the_parent_only_once(self):
        self.path.write_text(json.dumps({"tasks": [
            {"id": f"T-ISSUE-14-{i}", "github_issue_number": 14, "status": "done"}
            for i in (1, 2)]}))
        self.assertEqual(webhook_server.sync_tasks_to_issues(runner=self.github), 2)
        self.assertEqual(len(self.github.commands("close")), 1)
        self.assertEqual(len(self.github.commands("comment")), 2)

    def test_parent_edits_preserve_each_subtasks_implementation_scope(self):
        self.path.write_text(json.dumps({"tasks": [
            {"id": f"T-ISSUE-14-{i}", "github_issue_number": 14, "status": "approved",
             "total_subtasks": 2, "title": f"Part {i}", "description": f"Scope {i}"}
            for i in (1, 2)]}))
        self.assertTrue(self.deliver("edited"))
        for i, task in enumerate(self.data()["tasks"], 1):
            self.assertEqual((task["title"], task["description"]), (f"Part {i}", f"Scope {i}"))
            self.assertEqual(task["phase"], "Custom phase")

    def test_comment_lookup_failure_does_not_risk_a_duplicate_write(self):
        self.github.fail = ["gh", "api"]
        self.assertFalse(self.deliver())
        self.assertFalse(self.github.commands("comment"))
        self.assertFalse(self.data()["github_sync_events"])
        self.github.fail = None
        self.assertTrue(self.deliver())
        self.assertEqual(len(self.github.commands("comment")), 1)

    def test_stale_snapshot_does_not_restore_an_unlinked_active_task(self):
        self.deliver()
        self.change(status="in_progress")
        roadmap_store.update_roadmap(self.path, lambda data: data.update(current_task_id="T-ISSUE-14") or True)
        stale = self.data()
        self.issue["updated_at"] = "2026-10-16T14:01:00Z"
        self.deliver("unlabeled")
        roadmap_store.save_roadmap(self.path, stale)
        self.assertEqual(self.task()["status"], "paused")
        self.assertIsNone(self.data()["current_task_id"])
