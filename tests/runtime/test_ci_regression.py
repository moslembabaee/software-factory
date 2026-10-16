"""Regression diagnostics stay bounded and tied to one immutable CI head."""
import json
from pathlib import Path
import unittest
from unittest.mock import Mock, patch

import pr_lifecycle as lifecycle


class RegressionTests(unittest.TestCase):
    def test_normalizes_actions_prefixes_ansi_and_runner_diagnostics(self):
        log = "\n".join([
            "unit\tRun tests\t2026-10-16T00:00:00.000Z  \x1b[31mFAIL tests/unit.test.ts > suite > regression\x1b[0m",
            "unit\tRun tests\t2026-10-16T00:00:00.000Z AssertionError: expected true",
            "unit\tRun tests\t2026-10-16T00:00:00.000Z     at src/worker.ts:8:3",
            "  × handles (nested) arguments (12ms)",
            "not ok 2 - repairs regression",
            "src/index.ts(1,2): error TS2322: wrong type",
            "FAILED tests/test_ci.py::test_regression - AssertionError",
        ])
        context = lifecycle.parse_ci_error_logs(log)
        self.assertIn("tests/unit.test.ts", context["failing_tests"])
        self.assertIn("handles (nested) arguments", context["failing_tests"])
        self.assertIn("repairs regression", context["failing_tests"])
        self.assertIn("tests/test_ci.py::test_regression", context["failing_tests"])
        self.assertIn("src/index.ts", context["failing_files"])
        self.assertEqual(context["error_messages"], ["AssertionError: expected true", "error TS2322: wrong type"])
        self.assertEqual(context["stack_traces"], ["at src/worker.ts:8:3"])
        self.assertNotIn("\x1b", context["raw_log_tail"])

    def test_parses_python_traceback_and_root_level_files(self):
        context = lifecycle.parse_ci_error_logs(
            'ERROR: test_worker (test_worker.Tests)\nTraceback (most recent call last):\n'
            '  File "worker.py", line 9, in run\n    raise ValueError("bad")\nValueError: bad')
        self.assertEqual(context["failing_tests"], ["test_worker (test_worker.Tests)"])
        self.assertIn("worker.py", context["failing_files"])
        self.assertIn("ValueError: bad", context["stack_traces"][0])
        self.assertEqual(context["error_messages"], ["ValueError: bad"])

    def test_bounds_unterminated_tracebacks_large_lines_and_duplicate_errors(self):
        context = lifecycle.parse_ci_error_logs("x" * 1000000 + "\nTraceback (most recent call last):\n" +
            "\n".join(f"    at src/worker{i}.ts:1:2" for i in range(1000)) +
            "\nTypeError: bad\nTypeError: bad\n")
        self.assertEqual(context["error_messages"], ["TypeError: bad"])
        for key in ("failing_tests", "error_messages", "failing_files", "stack_traces"):
            self.assertLessEqual(len(context[key]), 30)
        self.assertLessEqual(len(context["raw_log_tail"]), 4000)
        self.assertTrue(all(len(trace) <= 4000 for trace in context["stack_traces"]))
        self.assertLessEqual(len(context["summary"]), 300)
        self.assertEqual(lifecycle.parse_ci_error_logs("")["summary"], "CI build/test failure detected")

    def test_log_fetch_ignores_unrelated_and_successful_runs_and_caps_requests(self):
        runs = [{"databaseId": 1, "headSha": "other", "conclusion": "failure"},
                {"databaseId": 2, "headSha": "expected", "conclusion": "success"}]
        runs += [{"databaseId": i, "headSha": "expected", "conclusion": "failure"} for i in range(3, 8)]
        runner = Mock(side_effect=[(0, json.dumps(runs)), (0, "TypeError: broken"), (1, "private"), (0, "Error: failed")])
        logs = lifecycle.fetch_ci_failure_logs(7, Path("/tmp"), "owner/repo", runner, 5, head_sha="expected")
        self.assertEqual(runner.call_count, 4)
        self.assertIn("TypeError: broken", logs)
        self.assertNotIn("private", logs)
        self.assertEqual([c.args[0][3] for c in runner.call_args_list[1:]], ["3", "4", "5"])
        for call in runner.call_args_list:
            self.assertIn("owner/repo", call.args[0])
            self.assertLessEqual(call.args[1], 5)
        self.assertIn("expected", runner.call_args_list[0].args[0])

    def test_one_deadline_prevents_multiplying_slow_ci_requests(self):
        runner = Mock(return_value=(0, json.dumps([
            {"databaseId": 3, "headSha": "expected", "conclusion": "failure"}])))
        with patch.object(lifecycle.time, "monotonic", side_effect=[100, 101, 161]):
            logs = lifecycle.fetch_ci_failure_logs(7, Path("/tmp"), runner=runner, timeout=120, head_sha="expected")
        runner.assert_called_once()
        self.assertEqual(runner.call_args.args[1], 59)
        self.assertIn("PR #7", logs)

    def test_no_head_never_uses_interactive_run_picker(self):
        runner = Mock()
        lifecycle.fetch_ci_failure_logs(7, Path("/tmp"), runner=runner)
        runner.assert_not_called()
