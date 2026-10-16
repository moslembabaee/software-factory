"""Read-only reviewer and policy tests; no agents, remote APIs or credentials."""
import json
import math
from pathlib import Path
from threading import Barrier, Event
import time
import unittest
from unittest.mock import patch

import orchestrator
import pr_lifecycle as lifecycle


CLEAN_DIFF = "diff --git a/src/app.ts b/src/app.ts\n+const clean = true;\n"


class ConsensusReviewTests(unittest.TestCase):
    def setUp(self):
        self.security = lifecycle.evaluate_security_review(CLEAN_DIFF)
        self.lint = lifecycle.evaluate_lint_review(CLEAN_DIFF)

    def gate(self, reviews=None, **policy):
        return lifecycle.evaluate_consensus_review_gate(
            [self.security, self.lint] if reviews is None else reviews, **policy)

    def test_clean_diff_passes_and_security_and_lint_rejections_veto_merge(self):
        self.assertTrue(self.gate()["passed"])
        for line, role in (("eval(input);", "security"), ("DROP POLICY tenants ON projects;", "security"),
                           ("ALTER TABLE projects DISABLE ROW LEVEL SECURITY;", "security"),
                           ("debugger;", "lint"), ("breakpoint()", "lint")):
            with self.subTest(line=line):
                result = self.gate(lifecycle.dispatch_parallel_reviews(CLEAN_DIFF + "+" + line + "\n"))
                self.assertFalse(result["passed"])
                self.assertFalse(result[f"{role}_gate_passed"])

    def test_missing_duplicate_and_malformed_evidence_fails_closed(self):
        for reviews in ([], [self.security], [self.lint],
                        [self.security, {**self.lint, "agent": self.security["agent"].upper()}],
                        [self.security, None], [self.security, {**self.lint, "passed": "true"}],
                        [self.security, {**self.lint, "findings": [None]}]):
            with self.subTest(reviews=reviews):
                self.assertFalse(self.gate(reviews)["passed"])

    def test_thresholds_and_role_vetoes_cannot_be_outvoted(self):
        general = {**self.lint, "role": "general", "agent": "general"}
        reject = {**general, "agent": "reject", "decision": "rejected", "passed": False}
        reviews = [self.security, self.lint, general, reject]
        self.assertTrue(self.gate(reviews, approval_threshold=0.75)["passed"])
        self.assertFalse(self.gate(reviews, approval_threshold=0.76)["passed"])
        self.assertFalse(self.gate(min_approvals=3)["passed"])
        for role in ("security", "lint"):
            veto = {**reject, "agent": f"veto-{role}", "role": role}
            result = self.gate(reviews + [veto], approval_threshold=0.5)
            self.assertFalse(result["passed"])
            self.assertFalse(result[f"{role}_gate_passed"])

    def test_severity_policies_apply_to_all_roles(self):
        extra = {**self.lint, "agent": "architect", "role": "architecture"}
        for severity in ("critical", "error"):
            extra["findings"] = [{"rule_id": "ARCH-ERROR", "severity": severity, "message": "Unsafe design"}]
            self.assertFalse(self.gate([self.security, self.lint, extra])["passed"])
        extra["findings"][0]["severity"] = "warning"
        self.assertTrue(self.gate([self.security, self.lint, extra])["passed"])

    def test_invalid_policy_cannot_disable_thresholds(self):
        for policy in ({"min_approvals": 0}, {"min_approvals": True},
                       {"approval_threshold": math.nan}, {"approval_threshold": math.inf},
                       {"approval_threshold": 1.1}, {"require_security": "false"},
                       {"required_roles": ["owner"]}):
            with self.subTest(policy=policy), self.assertRaises(ValueError):
                self.gate(**policy)

    def test_specialists_run_concurrently_and_preserve_order(self):
        barrier = Barrier(2, timeout=1)
        def security(*_args):
            barrier.wait()
            return self.security
        def lint(*_args):
            barrier.wait()
            return self.lint
        with patch.object(lifecycle, "evaluate_security_review", side_effect=security), \
                patch.object(lifecycle, "evaluate_lint_review", side_effect=lint):
            reviews = lifecycle.dispatch_parallel_reviews(CLEAN_DIFF, review_timeout=2)
        self.assertEqual([e["role"] for e in reviews], ["security", "lint"])
        self.assertTrue(self.gate(reviews)["passed"])

    def test_stalled_specialist_has_bounded_deadline_and_blocks_even_with_disabled_severity_policy(self):
        release = Event()
        def stall(*_args):
            release.wait()
            return self.security
        try:
            with patch.object(lifecycle, "evaluate_security_review", side_effect=stall):
                start = time.monotonic()
                reviews = lifecycle.dispatch_parallel_reviews(CLEAN_DIFF, review_timeout=0.03)
                self.assertLess(time.monotonic() - start, 1)
            self.assertEqual(reviews[0]["role"], "security")
            self.assertIn("timed out", reviews[0]["summary"])
            self.assertFalse(self.gate(reviews, block_on_critical=False, block_on_error=False)["passed"])
        finally:
            release.set()

    def test_exceptions_and_malformed_results_are_sanitized_blocking_evidence(self):
        def fail():
            raise RuntimeError("sensitive exception detail")
        reviews = lifecycle.dispatch_parallel_reviews(CLEAN_DIFF, custom_evaluators=[fail, lambda: None])
        self.assertEqual(len(reviews), 4)
        self.assertFalse(self.gate(reviews)["passed"])
        self.assertNotIn("sensitive exception detail", json.dumps(reviews))
        self.assertFalse(self.gate(reviews, approval_threshold=0, block_on_critical=False, block_on_error=False)["passed"])

    def test_hunk_locations_context_removals_and_redacted_credentials(self):
        token = "ghp_" + "a" * 24
        diff = ("diff --git a/src/auth.ts b/src/auth.ts\n--- a/src/auth.ts\n+++ b/src/auth.ts\n"
                "@@ -20,2 +20,3 @@\n const safe = 1;\n-eval(old);\n+// token: " + token + "\n+eval(input);\n")
        review = lifecycle.evaluate_security_review(diff)
        self.assertEqual([(f["rule_id"], f["line"]) for f in review["findings"]],
                         [("SEC-TOKEN-LEAK", 21), ("SEC-UNSAFE-EVAL", 22)])
        self.assertNotIn(token, json.dumps(review))
        combined = lifecycle.evaluate_security_review(f"const token = '{token}'; eval(input);")
        self.assertNotIn(token, json.dumps(combined))
        self.assertTrue(lifecycle.evaluate_security_review("import { x } from '../../utils.js';")["passed"])

    def test_orchestrator_uses_configured_threshold_and_deadline_for_review_and_publication(self):
        config = orchestrator.RuntimeConfig(project_root=Path("/tmp"), review_timeout=0.25,
                                            review_min_approvals=3, review_approval_threshold=1)
        worker = orchestrator.AgentRuntime(config)
        with patch.object(lifecycle, "dispatch_parallel_reviews", return_value=[self.security, self.lint]) as dispatch:
            self.assertFalse(worker.evaluate_review_gate(CLEAN_DIFF)["passed"])
        self.assertEqual(dispatch.call_args.kwargs["review_timeout"], 0.25)
        with patch.object(lifecycle, "run_pr_lifecycle_for_verified_task", return_value=(True, {"pr_status": "open"})) as publish:
            self.assertEqual(worker.publish({"id": "T-review"}), (True, "open"))
        self.assertEqual(publish.call_args.kwargs["review_policy"], config.review_policy)
        self.assertEqual(publish.call_args.kwargs["review_timeout"], 0.25)
