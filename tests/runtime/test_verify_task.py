"""Verification executor lifecycle, transport and command-line regressions."""

import fcntl
import json
import math
from pathlib import Path
import shlex
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import Mock

import roadmap_store
import verify_task as verifier


class VerificationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="sf-verify-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.path = self.root / "ROADMAP.json"
        self.task = {"id": "T-verify", "status": "ready_for_verification", "retry_count": 2,
                     "verification_cmd": "pwd; echo stdout; echo stderr >&2",
                     "custom": {"nested": [1, 2]}, "attempts": [{"agent": "codex"}]}
        self.path.write_text(json.dumps({"tasks": [self.task, {"id": "other", "status": "approved"}],
                                         "current_task_id": "T-verify", "metadata": {"keep": True}}))

    def data(self):
        return json.loads(self.path.read_text())

    def latest(self):
        return self.data()["tasks"][0]

    def change(self, **fields):
        def apply(data):
            data["tasks"][0].update(fields)
            return True
        roadmap_store.update_roadmap(self.path, apply)

    def verify(self, **kwargs):
        return verifier.verify_task("T-verify", self.root, **kwargs)

    def cli(self, *args):
        return subprocess.run(
            [sys.executable, str(verifier.PROJECT_ROOT / "verify_task.py"), *args,
             "--project-root", str(self.root)],
            cwd="/tmp", capture_output=True, text=True, timeout=5,
        )

    def test_success_captures_both_streams_in_repository_and_preserves_fields(self):
        before = self.data()
        result = self.verify()
        self.assertEqual((result.outcome, result.exit_code), ("verified", 0))
        self.assertIn(str(self.root), result.log_tail)
        self.assertIn("stdout", result.log_tail)
        self.assertIn("stderr", result.log_tail)
        task = self.latest()
        record = task.pop("verifications")[0]
        self.assertEqual(record["exit_code"], 0)
        self.assertEqual(record["log_tail"], result.log_tail)
        self.assertRegex(record["timestamp"], r"^\d{4}-\d{2}-\d{2}T.*\+00:00$")
        before["tasks"][0]["status"] = "verified"
        after = self.data()
        after["tasks"][0] = task
        self.assertEqual(after, before)
        # A repeated CLI invocation must not rerun a successfully verified task.
        runner = Mock()
        self.assertEqual(self.verify(runner=runner).outcome, "cancelled")
        runner.assert_not_called()

    def test_failures_increment_once_per_execution_and_append_history(self):
        self.change(verification_cmd="echo diagnostic >&2; exit 7", last_error="older error")
        for attempt in range(2):
            result = self.verify()
            self.assertEqual((result.outcome, result.exit_code), ("failed", 7))
            self.assertEqual(self.latest()["status"], "in_progress")
            self.assertEqual(self.latest()["retry_count"], 3 + attempt)
        task = self.latest()
        self.assertEqual(len(task["verifications"]), 2)
        self.assertEqual(task["verification_failures"], ["diagnostic\n"] * 2)
        self.assertIn("diagnostic", task["last_error"])
        self.assertEqual(task["attempts"], self.task["attempts"])

    def test_hard_timeout_retains_output_and_records_failure(self):
        program = "import time; print('before timeout', flush=True); time.sleep(30)"
        self.change(verification_cmd=shlex.join([sys.executable, "-c", program]))
        result = self.verify(timeout=0.2)
        self.assertEqual((result.outcome, result.exit_code), ("failed", -1))
        self.assertIn("timed out", result.log_tail)
        self.assertIn("before timeout", result.log_tail)
        self.assertEqual(self.latest()["retry_count"], 3)

    def test_record_stores_bounded_tail(self):
        program = "import sys; sys.stdout.write('x' * 100000 + 'THE END')"
        self.change(verification_cmd=shlex.join([sys.executable, "-c", program]))
        self.verify()
        record = self.latest()["verifications"][0]
        self.assertLessEqual(len(record["log_tail"]), verifier.LOG_LIMIT)
        self.assertTrue(record["log_tail"].endswith("THE END"))

    def test_stderr_is_analyzed_before_log_tail_truncation(self):
        program = ("import sys; "
                   "sys.stderr.write('src/worker.ts(12,5): error TS2322: Type mismatch\\n' + 'noise\\n' * 1000); "
                   "sys.exit(1)")
        self.change(verification_cmd=shlex.join([sys.executable, "-c", program]))
        result = self.verify()
        self.assertNotIn("TS2322", result.log_tail)
        analysis = result.failure_analysis
        self.assertIn("TS2322", analysis["summary"])
        self.assertEqual(analysis["implicated_files"], ["src/worker.ts"])
        self.assertEqual(analysis["command"], self.latest()["verification_cmd"])
        self.assertEqual(self.latest()["failure_analysis"], analysis)
        self.assertEqual(self.latest()["verifications"][0]["failure_analysis"], analysis)

    def test_success_clears_live_reflection_and_preserves_failure_history(self):
        self.change(verification_cmd="echo 'Error: broken' >&2; exit 1")
        self.verify()
        self.change(verification_cmd="true")
        result = self.verify()
        self.assertIsNone(result.failure_analysis)
        self.assertNotIn("failure_analysis", self.latest())
        self.assertNotIn("failure_summary", self.latest())
        self.assertIn("Error: broken", self.latest()["verifications"][0]["failure_analysis"]["summary"])

    def test_missing_command_is_explicitly_skipped_without_changing_status_or_retry(self):
        for command in (None, "", "  ", 123):
            with self.subTest(command=command):
                self.change(verification_cmd=command, verifications=[])
                before = self.data()
                runner = Mock()
                result = self.verify(runner=runner)
                runner.assert_not_called()
                self.assertEqual(result.outcome, "skipped")
                after = self.data()
                record = after["tasks"][0].pop("verifications")[-1]
                self.assertEqual(record["exit_code"], None)
                self.assertTrue(record["skipped"])
                self.assertIn("no verification_cmd", record["note"])
                before["tasks"][0].pop("verifications")
                self.assertEqual(after, before)
                unchanged = self.path.read_bytes()
                self.assertEqual(self.verify().outcome, "skipped")
                self.assertEqual(self.path.read_bytes(), unchanged)

    def test_dry_run_cli_neither_executes_nor_writes_even_lock_files(self):
        self.change(verification_cmd="touch executed")
        before = self.path.read_bytes()
        files = sorted(p.name for p in self.root.iterdir())
        process = self.cli("T-verify", "--dry-run")
        self.assertEqual(process.returncode, 0, process.stderr)
        self.assertEqual(json.loads(process.stdout)["outcome"], "dry_run")
        self.assertIn("touch executed", process.stdout)
        self.assertEqual(self.path.read_bytes(), before)
        self.assertEqual(sorted(p.name for p in self.root.iterdir()), files)

    def test_cli_success_failure_skip_and_unknown_task_exit_codes(self):
        process = self.cli("T-verify")
        self.assertEqual(process.returncode, 0, process.stderr)
        self.assertEqual(json.loads(process.stdout)["outcome"], "verified")
        self.change(status="ready_for_verification", verification_cmd="exit 9")
        process = self.cli("T-verify")
        self.assertEqual(process.returncode, 1, process.stderr)
        self.assertEqual(json.loads(process.stdout)["exit_code"], 9)
        self.change(verification_cmd=None)
        process = self.cli("T-verify")
        self.assertEqual(process.returncode, 0, process.stderr)
        self.assertIn("no verification_cmd", process.stdout)
        before = self.path.read_bytes()
        process = self.cli("unknown")
        self.assertEqual(process.returncode, 2)
        self.assertIn("Unknown task", process.stderr)
        self.assertEqual(self.path.read_bytes(), before)

    def test_invalid_timeouts_are_rejected_without_execution_or_update(self):
        for timeout in (0, -1, math.inf, math.nan):
            with self.subTest(timeout=timeout), self.assertRaises(ValueError):
                self.verify(timeout=timeout)
        process = self.cli("T-verify", "--timeout", "0")
        self.assertEqual(process.returncode, 2)
        self.assertNotIn("verifications", self.latest())

    def test_concurrent_verifier_is_busy_and_does_not_execute(self):
        logs = self.root / "logs"
        logs.mkdir()
        runner = Mock()
        with (logs / "verification.lock").open("a") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            self.assertEqual(self.verify(runner=runner).outcome, "busy")
        runner.assert_not_called()
        self.assertNotIn("verifications", self.latest())

    def test_updates_merge_into_latest_task_and_preserve_concurrent_edits(self):
        def run(*_args):
            def update(data):
                data["tasks"][0]["custom"]["concurrent"] = True
                data["tasks"].append({"id": "new"})
                data["metadata"]["concurrent"] = True
                return True
            roadmap_store.update_roadmap(self.path, update)
            return 0, "done"

        self.assertEqual(self.verify(runner=run).outcome, "verified")
        data = self.data()
        self.assertTrue(data["metadata"]["concurrent"])
        self.assertTrue(data["tasks"][0]["custom"]["concurrent"])
        self.assertEqual(data["tasks"][-1], {"id": "new"})

    def test_closure_cancellation_and_changed_commands_are_never_overwritten(self):
        for fields in ({"status": "cancelled"}, {"closed_at": "external-close"},
                       {"verification_cmd": "false"}, {"build_approval": {"revision": "new"}}):
            with self.subTest(fields=fields):
                self.change(**self.task, closed_at=None, build_approval=None)

                def run(*_args):
                    self.change(**fields)
                    return 0, "stale output"

                self.assertEqual(self.verify(runner=run).outcome, "cancelled")
                task = self.latest()
                for key, value in fields.items():
                    self.assertEqual(task[key], value)
                self.assertNotIn("verifications", task)

    def test_inactive_or_closed_tasks_never_execute(self):
        for status in ("approved", "waiting_approval", "verified", "completed", "cancelled"):
            self.change(status=status)
            runner = Mock()
            self.assertEqual(self.verify(runner=runner).outcome, "cancelled")
            runner.assert_not_called()
        self.change(status="ready_for_verification", closed_at="closed")
        self.assertEqual(self.verify().outcome, "cancelled")


if __name__ == "__main__":
    unittest.main()
