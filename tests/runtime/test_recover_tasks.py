"""Stale-task recovery, exponential backoff, escalation, and idempotency tests."""

from datetime import datetime, timedelta, timezone
import fcntl
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import Mock

import orchestrator
import recover_tasks as recovery
import roadmap_store


class RecoverTasksTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="sf-recover-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.roadmap_path = self.root / "ROADMAP.json"
        self.maintainers_path = self.root / "maintainers.json"
        self.log_path = self.root / "logs" / "recovery.log"

        self.maintainers_path.write_text(json.dumps({
            "authorized_approvers": ["moslembabaee", "lead-dev"],
            "approval_keywords": ["/approve", "LGTM"],
        }))

        self.base_time = datetime(2026, 10, 16, 12, 0, 0, tzinfo=timezone.utc)

    def write_roadmap(self, tasks: list[dict], current_task_id: str | None = None) -> None:
        data = {
            "project": "Software Factory",
            "version": "1.0.0",
            "current_task_id": current_task_id,
            "tasks": tasks,
        }
        self.roadmap_path.write_text(json.dumps(data, indent=2))

    def load_roadmap(self) -> dict:
        return json.loads(self.roadmap_path.read_text(encoding="utf-8"))

    def test_in_progress_stale_task_recovers_to_waiting_approval_with_backoff(self):
        started_at = (self.base_time - timedelta(minutes=45)).isoformat()
        task = {
            "id": "T-STALE-1",
            "title": "Stale in-progress task",
            "status": "in_progress",
            "assigned_agent": "claude",
            "retry_count": 0,
            "started_at": started_at,
            "verification_cmd": "echo test",
        }
        self.write_roadmap([task], current_task_id="T-STALE-1")

        mock_runner = Mock(return_value=(0, "ok"))
        actions = recovery.recover_tasks(
            self.roadmap_path,
            project_root=self.root,
            now=self.base_time,
            structured_log_file=self.log_path,
            runner=mock_runner,
        )

        self.assertEqual(len(actions), 1)
        action = actions[0]
        self.assertEqual(action.action, "recover")
        self.assertEqual(action.task_id, "T-STALE-1")
        self.assertEqual(action.from_status, "in_progress")
        self.assertEqual(action.to_status, "waiting_approval")
        self.assertEqual(action.retry_count, 1)
        # 2^1 * 5 min = 10 min = 600s
        self.assertEqual(action.backoff_seconds, 600.0)
        expected_backoff_until = (self.base_time + timedelta(seconds=600)).isoformat()
        self.assertEqual(action.backoff_until, expected_backoff_until)

        updated = self.load_roadmap()
        self.assertIsNone(updated["current_task_id"])
        updated_task = updated["tasks"][0]
        self.assertEqual(updated_task["status"], "waiting_approval")
        self.assertEqual(updated_task["retry_count"], 1)
        self.assertEqual(updated_task["backoff_seconds"], 600.0)
        self.assertEqual(updated_task["backoff_until"], expected_backoff_until)
        self.assertIn("Stale task in 'in_progress'", updated_task["recovery_reason"])
        self.assertEqual(len(updated_task["recovery_history"]), 1)
        self.assertEqual(updated_task["recovery_history"][0]["retry_count"], 1)

        # Check structured log
        self.assertTrue(self.log_path.exists())
        log_lines = self.log_path.read_text().strip().splitlines()
        self.assertEqual(len(log_lines), 1)
        log_entry = json.loads(log_lines[0])
        self.assertEqual(log_entry["action"], "recover")
        self.assertEqual(log_entry["task_id"], "T-STALE-1")
        self.assertEqual(log_entry["retry_count"], 1)

    def test_assigned_and_waiting_approval_states_also_recover(self):
        stale_time = (self.base_time - timedelta(minutes=35)).isoformat()
        tasks = [
            {
                "id": "T-ASSIGNED",
                "status": "assigned",
                "assigned_agent": "codex",
                "retry_count": 0,
                "assigned_at": stale_time,
            },
            {
                "id": "T-WAITING",
                "status": "waiting_approval",
                "assigned_agent": "antigravity",
                "retry_count": 1,
                "waiting_approval_at": stale_time,
            },
        ]
        self.write_roadmap(tasks)

        actions = recovery.recover_tasks(
            self.roadmap_path,
            project_root=self.root,
            now=self.base_time,
            structured_log_file=self.log_path,
        )

        self.assertEqual(len(actions), 2)
        by_id = {a.task_id: a for a in actions}

        # T-ASSIGNED: retry_count becomes 1, backoff = 2^1 * 300 = 600s
        self.assertEqual(by_id["T-ASSIGNED"].to_status, "waiting_approval")
        self.assertEqual(by_id["T-ASSIGNED"].retry_count, 1)
        self.assertEqual(by_id["T-ASSIGNED"].backoff_seconds, 600.0)

        # T-WAITING: retry_count was 1, becomes 2, backoff = 2^2 * 300 = 1200s
        self.assertEqual(by_id["T-WAITING"].to_status, "waiting_approval")
        self.assertEqual(by_id["T-WAITING"].retry_count, 2)
        self.assertEqual(by_id["T-WAITING"].backoff_seconds, 1200.0)

    def test_fresh_tasks_are_not_recovered(self):
        recent_time = (self.base_time - timedelta(minutes=10)).isoformat()
        task = {
            "id": "T-FRESH",
            "status": "in_progress",
            "retry_count": 0,
            "started_at": recent_time,
        }
        self.write_roadmap([task], current_task_id="T-FRESH")

        actions = recovery.recover_tasks(
            self.roadmap_path,
            project_root=self.root,
            now=self.base_time,
            structured_log_file=self.log_path,
        )

        self.assertEqual(len(actions), 0)
        updated = self.load_roadmap()
        self.assertEqual(updated["current_task_id"], "T-FRESH")
        self.assertEqual(updated["tasks"][0]["status"], "in_progress")
        self.assertEqual(updated["tasks"][0]["retry_count"], 0)

    def test_unmonitored_and_closed_states_are_never_recovered(self):
        stale_time = (self.base_time - timedelta(hours=2)).isoformat()
        tasks = [
            {"id": "T-1", "status": "completed", "started_at": stale_time},
            {"id": "T-2", "status": "verified", "started_at": stale_time},
            {"id": "T-3", "status": "failed", "started_at": stale_time},
            {"id": "T-4", "status": "cancelled", "started_at": stale_time},
            {"id": "T-5", "status": "approved", "started_at": stale_time},
            {"id": "T-6", "status": "in_progress", "closed_at": stale_time, "started_at": stale_time},
        ]
        self.write_roadmap(tasks)

        actions = recovery.recover_tasks(
            self.roadmap_path,
            project_root=self.root,
            now=self.base_time,
            structured_log_file=self.log_path,
        )

        self.assertEqual(len(actions), 0)

    def test_configurable_per_state_ttl(self):
        # in_progress TTL: 10m (600s), waiting_approval TTL: 60m (3600s)
        time_15m_ago = (self.base_time - timedelta(minutes=15)).isoformat()
        tasks = [
            {"id": "T-INPROG", "status": "in_progress", "started_at": time_15m_ago, "retry_count": 0},
            {"id": "T-WAIT", "status": "waiting_approval", "waiting_approval_at": time_15m_ago, "retry_count": 0},
        ]
        self.write_roadmap(tasks)

        actions = recovery.recover_tasks(
            self.roadmap_path,
            project_root=self.root,
            ttls={"in_progress": 600, "waiting_approval": 3600},
            now=self.base_time,
            structured_log_file=self.log_path,
        )

        # Only T-INPROG should be recovered (15m > 10m, but 15m < 60m)
        self.assertEqual(len(actions), 1)
        self.assertEqual(actions[0].task_id, "T-INPROG")

    def test_exponential_backoff_capped_at_4_hours(self):
        # 2^1 * 5m = 10m (600s)
        self.assertEqual(recovery.compute_backoff_seconds(1), 600.0)
        # 2^2 * 5m = 20m (1200s)
        self.assertEqual(recovery.compute_backoff_seconds(2), 1200.0)
        # 2^3 * 5m = 40m (2400s)
        self.assertEqual(recovery.compute_backoff_seconds(3), 2400.0)
        # 2^6 * 5m = 320m = 5h20m > 4h -> capped at 14400s
        self.assertEqual(recovery.compute_backoff_seconds(6), 14400.0)
        self.assertEqual(recovery.compute_backoff_seconds(10), 14400.0)

    def test_escalation_after_max_retries_reaches_configurable_limit(self):
        stale_time = (self.base_time - timedelta(minutes=40)).isoformat()
        task = {
            "id": "T-ESCALATE-1",
            "title": "Stuck Task to Escalate",
            "status": "in_progress",
            "assigned_agent": "codex",
            "retry_count": 2,
            "started_at": stale_time,
            "github_issue_number": 99,
            "last_error": "SyntaxError in agent code",
            "attempts": [
                {"agent": "claude", "exit_code": 1, "failure": "agent", "timestamp": stale_time, "log_tail": "Error line 1"},
                {"agent": "codex", "exit_code": 1, "failure": "agent", "timestamp": stale_time, "log_tail": "Error line 2"},
            ],
        }
        self.write_roadmap([task], current_task_id="T-ESCALATE-1")

        mock_runner = Mock(return_value=(0, "ok"))
        actions = recovery.recover_tasks(
            self.roadmap_path,
            project_root=self.root,
            max_retries=3,
            now=self.base_time,
            structured_log_file=self.log_path,
            runner=mock_runner,
        )

        self.assertEqual(len(actions), 1)
        action = actions[0]
        self.assertEqual(action.action, "escalate")
        self.assertEqual(action.task_id, "T-ESCALATE-1")
        self.assertEqual(action.to_status, "escalated")
        self.assertEqual(action.retry_count, 3)
        self.assertIn("@moslembabaee", action.notice)
        self.assertIn("@lead-dev", action.notice)
        self.assertIn("SyntaxError in agent code", action.notice)

        updated = self.load_roadmap()
        self.assertIsNone(updated["current_task_id"])
        updated_task = updated["tasks"][0]
        self.assertEqual(updated_task["status"], "escalated")
        self.assertEqual(updated_task["retry_count"], 3)
        self.assertIn("escalation_notice", updated_task)
        self.assertIn("@moslembabaee", updated_task["escalation_notice"])

        # Check GitHub comment runner was invoked
        mock_runner.assert_called_once()
        cmd = mock_runner.call_args[0][0]
        self.assertEqual(cmd[:5], ["gh", "issue", "comment", "99", "--repo"])

        # Check structured log has escalation record
        log_lines = self.log_path.read_text().strip().splitlines()
        self.assertEqual(len(log_lines), 1)
        entry = json.loads(log_lines[0])
        self.assertEqual(entry["action"], "escalate")
        self.assertEqual(entry["to_status"], "escalated")
        self.assertEqual(entry["contacts"], ["moslembabaee", "lead-dev"])

    def test_idempotency_consecutive_runs_do_not_double_increment(self):
        stale_time = (self.base_time - timedelta(minutes=45)).isoformat()
        task = {
            "id": "T-IDEMPOTENT",
            "status": "in_progress",
            "retry_count": 0,
            "started_at": stale_time,
        }
        self.write_roadmap([task], current_task_id="T-IDEMPOTENT")

        # Run 1: Recovers task from in_progress to waiting_approval
        actions1 = recovery.recover_tasks(
            self.roadmap_path,
            project_root=self.root,
            now=self.base_time,
            structured_log_file=self.log_path,
        )
        self.assertEqual(len(actions1), 1)
        self.assertEqual(actions1[0].retry_count, 1)

        # Run 2: Executed 10 seconds later
        t2 = self.base_time + timedelta(seconds=10)
        actions2 = recovery.recover_tasks(
            self.roadmap_path,
            project_root=self.root,
            now=t2,
            structured_log_file=self.log_path,
        )
        # Should not double-increment!
        self.assertEqual(len(actions2), 0)

        task_after = self.load_roadmap()["tasks"][0]
        self.assertEqual(task_after["retry_count"], 1)
        self.assertEqual(task_after["status"], "waiting_approval")

    def test_process_lock_prevents_concurrent_runs(self):
        stale_time = (self.base_time - timedelta(minutes=45)).isoformat()
        task = {"id": "T-LOCK", "status": "in_progress", "started_at": stale_time}
        self.write_roadmap([task])

        # Hold the recovery lock externally
        lock_dir = self.root / "logs"
        lock_dir.mkdir(parents=True, exist_ok=True)
        lock_file = lock_dir / "recovery.lock"
        with lock_file.open("a") as held_lock:
            fcntl.flock(held_lock, fcntl.LOCK_EX | fcntl.LOCK_NB)

            # Attempt recovery while lock is held
            actions = recovery.recover_tasks(
                self.roadmap_path,
                project_root=self.root,
                now=self.base_time,
                structured_log_file=self.log_path,
            )
            self.assertEqual(actions, [])

        # Once lock released, recovery succeeds
        actions = recovery.recover_tasks(
            self.roadmap_path,
            project_root=self.root,
            now=self.base_time,
            structured_log_file=self.log_path,
        )
        self.assertEqual(len(actions), 1)

    def test_orchestrator_eligible_respects_backoff_until(self):
        runtime_config = orchestrator.RuntimeConfig(project_root=self.root)
        agent_runtime = orchestrator.AgentRuntime(runtime_config)

        # Task with future backoff_until
        future_task = {
            "id": "T-FUTURE",
            "status": "approved",
            "backoff_until": (datetime.now(timezone.utc) + timedelta(minutes=15)).isoformat(),
        }
        self.assertFalse(agent_runtime.eligible(future_task))

        # Task with past backoff_until
        past_task = {
            "id": "T-PAST",
            "status": "approved",
            "backoff_until": (datetime.now(timezone.utc) - timedelta(minutes=5)).isoformat(),
        }
        self.assertTrue(agent_runtime.eligible(past_task))

        # Task with no backoff_until
        normal_task = {"id": "T-NORMAL", "status": "approved"}
        self.assertTrue(agent_runtime.eligible(normal_task))

    def test_cli_dry_run_and_execution(self):
        stale_time = (datetime.now(timezone.utc) - timedelta(minutes=45)).isoformat()
        task = {
            "id": "T-CLI",
            "status": "in_progress",
            "started_at": stale_time,
            "retry_count": 0,
        }
        self.write_roadmap([task], current_task_id="T-CLI")

        # CLI dry-run
        res_dry = subprocess.run(
            [
                sys.executable,
                str(recovery.PROJECT_ROOT / "recover_tasks.py"),
                "--project-root", str(self.root),
                "--roadmap-file", str(self.roadmap_path),
                "--dry-run",
            ],
            capture_output=True,
            text=True,
            timeout=5,
        )
        self.assertEqual(res_dry.returncode, 0)
        self.assertIn("Dry run: 1 task(s) would be affected", res_dry.stdout)
        # Roadmap should remain unchanged
        self.assertEqual(self.load_roadmap()["tasks"][0]["status"], "in_progress")

        # CLI real execution
        res_real = subprocess.run(
            [
                sys.executable,
                str(recovery.PROJECT_ROOT / "recover_tasks.py"),
                "--project-root", str(self.root),
                "--roadmap-file", str(self.roadmap_path),
            ],
            capture_output=True,
            text=True,
            timeout=5,
        )
        self.assertEqual(res_real.returncode, 0)
        self.assertIn("Recovery completed: 1 task(s) processed", res_real.stdout)
        self.assertEqual(self.load_roadmap()["tasks"][0]["status"], "waiting_approval")
        self.assertEqual(self.load_roadmap()["tasks"][0]["retry_count"], 1)


if __name__ == "__main__":
    unittest.main()
