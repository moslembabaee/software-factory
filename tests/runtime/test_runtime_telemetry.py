"""Deterministic accounting regressions; no provider calls or sleeps."""
import unittest

import runtime_telemetry as telemetry


class UsageTests(unittest.TestCase):
    def test_final_nested_usage_accepts_reordered_fields_and_zero(self):
        tokens, estimated = telemetry.token_usage("prompt", '\n'.join([
            '{"usage":{"input_tokens":100,"output_tokens":2}}',
            '{"type":"turn.completed","usage":{"output_tokens":0,"input_tokens":120}}',
        ]))
        self.assertEqual(tokens, {"prompt": 120, "completion": 0, "total": 120})
        self.assertFalse(estimated)

    def test_text_totals_do_not_invent_extra_tokens(self):
        for output in ["tokens used\n2", "total_tokens: 2"]:
            tokens, estimated = telemetry.token_usage("long prompt" * 50, output)
            self.assertEqual(tokens, {"prompt": 2, "completion": 0, "total": 2})
            self.assertTrue(estimated)
        self.assertEqual(telemetry.token_usage("", "tokens used: 1,234")[0]["total"], 1234)

    def test_malformed_usage_falls_back_and_is_marked_estimated(self):
        for output in ['', '{"usage":', '{"input_tokens":-2,"output_tokens":5}',
                       '{"input_tokens":true,"output_tokens":5}']:
            tokens, estimated = telemetry.token_usage("prompt", output)
            self.assertTrue(estimated)
            self.assertEqual(tokens["total"], tokens["prompt"] + tokens["completion"])

    def test_configured_rates_and_zero_usage(self):
        tokens = {"prompt": 1000, "completion": 2000, "total": 3000}
        self.assertEqual(telemetry.token_cost("custom", tokens, {"custom": {"prompt": 1, "completion": 2}}), .005)
        self.assertEqual(telemetry.token_cost("claude", {"prompt": 0, "completion": 0}), 0)

    def test_budget_rejects_invalid_values_and_respects_explicit_unlimited(self):
        for value in [-1, float('nan'), float('inf'), True, '10']:
            with self.assertRaises(ValueError):
                telemetry.budget_cap({"budget_cap_usd": value})
        self.assertIsNone(telemetry.budget_cap({"budget_cap_usd": None}, 10))
        self.assertEqual(telemetry.budget_cap({}, 10), 10)

    def test_empty_metrics_have_no_nan_or_fictitious_cap(self):
        metrics = telemetry.build_metrics([])
        self.assertEqual(metrics["retry_rate"], 0)
        self.assertEqual(metrics["avg_latency_seconds"], 0)
        self.assertIsNone(metrics["budget"]["total_cap_usd"])
