"""Diagnostic parsing and bounded remediation, without provider calls."""

import json
import unittest

from failure_analysis import FailureAnalysis, ReflectionEngine


class ReflectionTests(unittest.TestCase):
    def setUp(self):
        self.engine = ReflectionEngine()

    def test_compiler_diagnostics_strip_ansi_and_preserve_source_locations(self):
        analysis = self.engine.analyze(2, (
            "\x1b[31msrc/a.ts(12,4): error TS2322: Wrong type\x1b[0m\n"
            "src/b.tsx:8:2 - error TS2304: Cannot find name\n"
        ), "npm run typecheck")
        first, second = analysis.parsed_diagnostics
        self.assertEqual((first.file, first.line, first.column, first.symbol),
                         ("src/a.ts", 12, 4, "TS2322"))
        self.assertEqual((second.file, second.line, second.column), ("src/b.tsx", 8, 2))
        self.assertNotIn("\x1b", analysis.raw_tail)
        restored = FailureAnalysis.from_dict(json.loads(json.dumps(analysis.to_dict())))
        self.assertEqual(restored, analysis)

    def test_vitest_assertion_and_stack_frame(self):
        analysis = self.engine.analyze(1, (
            " FAIL src/a.test.ts > worker > handles failure\n"
            "AssertionError: expected 1 to equal 2\n"
            "Expected: 2\n"
            " ❯ src/a.test.ts:20:3\n"
        ), "npm test")
        self.assertIn("src/a.test.ts: > worker > handles failure", analysis.failing_tests)
        self.assertTrue(analysis.assertion_errors)
        self.assertIn("src/a.test.ts", analysis.implicated_files)
        self.assertIn("src/a.test.ts:20:3", analysis.stack_traces[0])

    def test_tap_and_python_unittest_failures(self):
        for output, name in (
            ("not ok 3 - repository runtime", "repository runtime"),
            ("FAIL: test_worker (test_runtime.RuntimeTests)", "test_runtime.RuntimeTests.test_worker"),
        ):
            with self.subTest(output=output):
                self.assertEqual(self.engine.analyze(1, output).failing_tests, [name])

    def test_python_trace_includes_exception_and_node_error_is_recognized(self):
        analysis = self.engine.analyze(1, (
            'Traceback (most recent call last):\n  File "worker.py", line 4\n'
            'ValueError: invalid task\n\nError: missing dependency\n'
            'SyntaxError: Unexpected token\n'
        ))
        self.assertIn("ValueError: invalid task", analysis.runtime_errors)
        self.assertIn("Error: missing dependency", analysis.runtime_errors)
        self.assertEqual(analysis.compile_errors, ["SyntaxError: Unexpected token"])
        self.assertIn("ValueError", analysis.stack_traces[0])

    def test_timeout_remediation_includes_command_and_action_before_verbose_details(self):
        analysis = self.engine.analyze(-1, "Command timed out after 300s\n" + "noise\n" * 2000,
                                       "npm test")
        prompt = self.engine.synthesize_remediation(
            {"id": "T-repair", "verification_cmd": "npm test"}, analysis, "codex")
        self.assertIn("Remediation Prompt for codex", prompt)
        self.assertIn("timed out", prompt)
        self.assertIn("deadlocks", prompt)
        self.assertIn("Run the full verification command `npm test`", prompt)
        self.assertLessEqual(len(prompt), 4000)

    def test_unknown_nonzero_exit_keeps_useful_raw_evidence(self):
        analysis = self.engine.analyze(7, "custom verifier rejected configuration", "check-config")
        self.assertIn("exit code 7", analysis.summary)
        prompt = self.engine.synthesize_remediation({"id": "T-1"}, analysis)
        self.assertIn("custom verifier rejected configuration", prompt)
        self.assertIn("check-config", prompt)

    def test_large_output_and_duplicate_diagnostics_are_bounded(self):
        analysis = self.engine.analyze(1, "Error: repeated\n" * 10000)
        self.assertEqual(analysis.runtime_errors, ["Error: repeated"])
        self.assertLessEqual(len(analysis.parsed_diagnostics), 60)
        self.assertLessEqual(len(analysis.raw_tail), 4000)
        self.assertLessEqual(len(self.engine.synthesize_remediation({}, analysis)), 4000)

    def test_credentials_are_scrubbed_from_all_analysis_fields(self):
        secret = "ghp_" + "a" * 25
        analysis = self.engine.analyze(1, f"Error: unauthorized token {secret}")
        self.assertNotIn(secret, json.dumps(analysis.to_dict()))
        self.assertIn("[REDACTED]", analysis.raw_tail)
