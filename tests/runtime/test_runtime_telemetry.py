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

    def test_token_usage_reversed_and_split_formats(self):
        tokens, estimated = telemetry.token_usage("prompt", "tokens: 50 completion, 200 prompt")
        self.assertEqual(tokens, {"prompt": 200, "completion": 50, "total": 250})
        self.assertFalse(estimated)

        tokens, estimated = telemetry.token_usage("prompt", "input_tokens: 300, output_tokens: 75")
        self.assertEqual(tokens, {"prompt": 300, "completion": 75, "total": 375})
        self.assertFalse(estimated)

    def test_extended_agent_rates(self):
        tokens = {"prompt": 10000, "completion": 2000, "total": 12000}
        # sonnet: $3 / $15 per million
        self.assertEqual(telemetry.token_cost("claude-sonnet", tokens), 0.06)
        # haiku: $0.80 / $4.00 per million -> 10000*0.80/1M + 2000*4.00/1M = 0.008 + 0.008 = 0.016
        self.assertEqual(telemetry.token_cost("claude-haiku", tokens), 0.016)
        # opus: $15 / $75 per million -> 10000*15/1M + 2000*75/1M = 0.15 + 0.15 = 0.30
        self.assertEqual(telemetry.token_cost("claude-opus", tokens), 0.30)
        # gemini: $0.15 / $0.60 per million
        self.assertEqual(telemetry.token_cost("gemini", tokens), 0.0027)

    def test_task_telemetry_detailed_breakdown_and_retry_rate(self):
        task = {
            "budget_cap_usd": 1.0,
            "attempts": [
                {"agent": "claude", "failure": "agent"},
                {"agent": "codex", "failure": None},
            ],
            "telemetry": {
                "tokens": {"prompt": 1000, "completion": 200},
                "cost_usd": 0.006,
                "duration_seconds": 10.5,
                "agent_duration_seconds": 8.0,
                "verification_duration_seconds": 2.5,
                "failure_modes": {"agent": 1},
            },
        }
        stats = telemetry.task_telemetry(task)
        self.assertEqual(stats["tokens"], {"prompt": 1000, "completion": 200, "total": 1200})
        self.assertEqual(stats["cost_usd"], 0.006)
        self.assertEqual(stats["duration_seconds"], 10.5)
        self.assertEqual(stats["agent_duration_seconds"], 8.0)
        self.assertEqual(stats["verification_duration_seconds"], 2.5)
        self.assertEqual(stats["attempt_count"], 2)
        self.assertEqual(stats["failed_attempts"], 1)
        self.assertEqual(stats["retry_rate"], 0.5)
        self.assertEqual(stats["failure_modes"], {"agent": 1})
        self.assertEqual(stats["budget"], {"cap_usd": 1.0, "spent_usd": 0.006, "exceeded": False})

    def test_record_attempt_accumulates_and_tracks_failures(self):
        task = {"budget_cap_usd": 0.02}
        attempt1 = {
            "agent": "claude",
            "tokens": {"prompt": 1000, "completion": 200, "total": 1200},
            "cost_usd": 0.006,
            "duration_seconds": 4.0,
            "agent_duration_seconds": 3.0,
            "verification_duration_seconds": 1.0,
            "estimated_tokens": False,
            "failure": "verification",
        }
        telemetry.record_attempt(task, attempt1)
        self.assertEqual(task["telemetry"]["attempt_count"], 1)
        self.assertEqual(task["telemetry"]["failed_attempts"], 1)
        self.assertEqual(task["telemetry"]["cost_usd"], 0.006)
        self.assertEqual(task["telemetry"]["failure_modes"], {"verification": 1})
        self.assertFalse(task["telemetry"]["budget"]["exceeded"])

        attempt2 = {
            "agent": "codex",
            "tokens": {"prompt": 2000, "completion": 500, "total": 2500},
            "cost_usd": 0.015,
            "duration_seconds": 5.0,
            "agent_duration_seconds": 4.0,
            "verification_duration_seconds": 1.0,
            "estimated_tokens": False,
            "failure": None,
        }
        telemetry.record_attempt(task, attempt2)
        self.assertEqual(task["telemetry"]["attempt_count"], 2)
        self.assertEqual(task["telemetry"]["failed_attempts"], 1)
        self.assertEqual(task["telemetry"]["cost_usd"], 0.021)
        self.assertEqual(task["telemetry"]["retry_rate"], 0.5)
        self.assertTrue(task["telemetry"]["budget"]["exceeded"])

    def test_build_metrics_multitask_and_agents_breakdown(self):
        task1 = {
            "telemetry": {
                "tokens": {"prompt": 1000, "completion": 200, "total": 1200},
                "cost_usd": 0.006,
                "duration_seconds": 4.0,
                "attempt_count": 1,
                "retry_rate": 0,
                "failure_modes": {"agent": 1},
                "budget": {"cap_usd": 0.5, "spent_usd": 0.006, "exceeded": False},
            },
            "attempts": [
                {
                    "agent": "claude",
                    "tokens": {"prompt": 1000, "completion": 200, "total": 1200},
                    "cost_usd": 0.006,
                    "duration_seconds": 4.0,
                    "failure": "agent",
                }
            ],
        }
        task2 = {
            "telemetry": {
                "tokens": {"prompt": 2000, "completion": 400, "total": 2400},
                "cost_usd": 0.012,
                "duration_seconds": 6.0,
                "attempt_count": 2,
                "retry_rate": 0.5,
                "failure_modes": {"timeout": 1},
                "budget": {"cap_usd": 1.0, "spent_usd": 0.012, "exceeded": False},
            },
            "attempts": [
                {
                    "agent": "claude",
                    "tokens": {"prompt": 1000, "completion": 200, "total": 1200},
                    "cost_usd": 0.006,
                    "duration_seconds": 3.0,
                    "failure": "timeout",
                },
                {
                    "agent": "codex",
                    "tokens": {"prompt": 1000, "completion": 200, "total": 1200},
                    "cost_usd": 0.006,
                    "duration_seconds": 3.0,
                    "failure": None,
                },
            ],
        }
        metrics = telemetry.build_metrics([task1, task2])
        self.assertEqual(metrics["total_tokens"], 3600)
        self.assertEqual(metrics["total_cost_usd"], 0.018)
        self.assertEqual(metrics["attempt_count"], 3)
        self.assertEqual(metrics["avg_latency_seconds"], 3.333)
        self.assertEqual(metrics["retry_rate"], 0.3333)
        self.assertEqual(metrics["failure_modes"], {"agent": 1, "timeout": 1})
        self.assertEqual(metrics["budget"]["total_cap_usd"], 1.5)
        self.assertFalse(metrics["budget"]["exceeded"])

        agents = {row["agent"]: row for row in metrics["agents"]}
        self.assertEqual(agents["claude"]["attempt_count"], 2)
        self.assertEqual(agents["claude"]["failed_attempts"], 2)
        self.assertEqual(agents["claude"]["total_tokens"], 2400)
        self.assertEqual(agents["claude"]["retry_rate"], 0)
        self.assertEqual(agents["claude"]["failure_modes"], {"agent": 1, "timeout": 1})

        self.assertEqual(agents["codex"]["attempt_count"], 1)
        self.assertEqual(agents["codex"]["failed_attempts"], 0)
        self.assertEqual(agents["codex"]["retry_rate"], 1.0)

    def test_enforce_budget(self):
        task = {"budget_cap_usd": 0.05, "telemetry": {"cost_usd": 0.04}}
        # Within budget
        check = telemetry.enforce_budget(task, proposed_cost=0.005)
        self.assertTrue(check["allowed"])
        self.assertFalse(check["exceeded"])
        self.assertEqual(check["projected_usd"], 0.045)
        self.assertIsNone(check["reason"])

        # Exceeds budget
        check2 = telemetry.enforce_budget(task, proposed_cost=0.015)
        self.assertFalse(check2["allowed"])
        self.assertTrue(check2["exceeded"])
        self.assertEqual(check2["projected_usd"], 0.055)
        self.assertEqual(check2["reason"], "Budget limit exceeded")

        # Unlimited budget (None cap)
        unlimited_task = {"budget_cap_usd": None, "telemetry": {"cost_usd": 100.0}}
        check3 = telemetry.enforce_budget(unlimited_task, proposed_cost=50.0)
        self.assertTrue(check3["allowed"])
        self.assertFalse(check3["exceeded"])
        self.assertIsNone(check3["cap_usd"])

