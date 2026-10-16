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


class AggregationTests(unittest.TestCase):
    def attempt(self, agent='codex', latency=2, failure=None, **fields):
        return {
            'agent': agent, 'model': 'test-model', 'failure': failure, 'finalized': True,
            'tokens': {'prompt': 1000, 'completion': 200, 'total': 1200},
            'cost_usd': .005, 'estimated_tokens': False,
            'duration_seconds': latency + 1, 'agent_duration_seconds': latency,
            'verification_duration_seconds': 1, **fields,
        }

    def test_recording_custom_rates_preserves_each_cost_component_across_retries(self):
        task = {'status': 'in_progress'}
        for agent, failure in [('codex', 'timeout'), ('claude', None)]:
            tokens = {'prompt': 1000, 'completion': 200, 'total': 1200}
            parts = telemetry.token_cost_breakdown(agent, tokens, {agent: {'prompt': 1, 'completion': 20}})
            telemetry.record_attempt(task, self.attempt(agent, failure=failure,
                cost_usd=parts['total_cost_usd'], prompt_cost_usd=parts['prompt_cost_usd'],
                completion_cost_usd=parts['completion_cost_usd']))
        for stats in (task['telemetry'], telemetry.build_metrics([task])):
            self.assertEqual(stats['prompt_cost_usd'], .002)
            self.assertEqual(stats['completion_cost_usd'], .008)
            self.assertEqual(stats.get('total_cost_usd', stats.get('cost_usd')), .01)
            self.assertEqual(stats['successful_attempts'], 1)
            self.assertEqual(stats['failed_attempts'], 1)
            self.assertEqual(stats['success_rate'], .5)
            self.assertEqual(stats['retry_rate'], .5)
        self.assertEqual(task['telemetry']['tokens']['total'], 2400)
        self.assertEqual(task['telemetry']['failure_modes'], {'timeout': 1})

    def test_legacy_cost_splits_reconcile_without_repricing_recorded_spend(self):
        task = {'assigned_agent': 'codex', 'attempts': [self.attempt(cost_usd=.123456)]}
        stats = telemetry.build_metrics([task])
        for row in [stats, *stats['agents'], *stats['models']]:
            self.assertAlmostEqual(row['prompt_cost_usd'] + row['completion_cost_usd'], .123456)
            self.assertEqual(row['total_cost_usd'], .123456)
        # Recording a second old-format attempt must also increase the split.
        telemetry.record_attempt(task, self.attempt(cost_usd=.123456))
        self.assertAlmostEqual(task['telemetry']['prompt_cost_usd'] + task['telemetry']['completion_cost_usd'], .246912)

    def test_pending_verification_is_not_success_and_finalization_changes_distribution(self):
        task = {'status': 'ready_for_verification', 'active_attempt': {'phase': 'verification'},
                'attempts': [self.attempt(finalized=False)]}
        for stats in (telemetry.task_telemetry(task), telemetry.build_metrics([task])):
            self.assertEqual(stats['successful_attempts'], 0)
            self.assertEqual(stats['pending_attempts'], 1)
            self.assertEqual(stats['success_rate'], 0)
        task['attempts'][0].update(finalized=True, failure='verification')
        task.pop('active_attempt')
        stats = telemetry.build_metrics([task])
        self.assertEqual(stats['pending_attempts'], 0)
        self.assertEqual(stats['failure_rate'], 1)
        self.assertEqual(stats['agents'][0]['failure_modes'], {'verification': 1})

    def test_model_grouping_provider_percentiles_and_disjoint_lifecycle_counts(self):
        tasks = [
            {'status': 'completed', 'attempts': [self.attempt(latency=1), self.attempt(latency=10, failure='timeout')]},
            {'status': 'ready_for_verification', 'active_attempt': {'phase': 'verification'},
             'attempts': [self.attempt(agent='claude', latency=3, model='other', finalized=False)]},
            {'status': 'cancelled', 'closed_at': '2026-10-16T00:00:00Z', 'active_attempt': {'phase': 'agent'}},
            {'status': 'failed'}, {'status': 'approved'}, {'status': 'cancelled'},
        ]
        stats = telemetry.build_metrics(tasks)
        self.assertEqual(stats['p50_latency_seconds'], 3)
        self.assertEqual(stats['p95_latency_seconds'], 10)
        self.assertEqual(stats['avg_latency_seconds'], round(17 / 3, 3))
        self.assertEqual(stats['avg_agent_latency_seconds'], round(14 / 3, 3))
        self.assertEqual(stats['avg_verification_latency_seconds'], 1)
        self.assertEqual(stats['pending_attempts'], 1)
        self.assertEqual(stats['success_rate'], .5)
        self.assertEqual(stats['total_tasks_count'], 6)
        self.assertEqual(stats['completed_tasks_count'], 2)
        self.assertEqual(stats['active_tasks_count'], 1)
        self.assertEqual(stats['active_agent_count'], 1)
        self.assertEqual(stats['pending_tasks_count'], 1)
        self.assertEqual(stats['failed_tasks_count'], 1)
        self.assertEqual(stats['task_lifecycle_counts']['cancelled'], 1)
        self.assertEqual([(row['agent'], row['model']) for row in stats['models']],
                         [('claude', 'other'), ('codex', 'test-model')])
        self.assertEqual(stats['models'][1]['p50_latency_seconds'], 1)
        self.assertEqual(stats['models'][1]['p95_latency_seconds'], 10)

    def test_empty_metrics_and_unknown_models_are_explicit(self):
        import json
        stats = telemetry.build_metrics([])
        json.dumps(stats, allow_nan=False)
        self.assertEqual(stats['models'], [])
        self.assertEqual(stats['task_lifecycle_counts'], {})
        self.assertEqual(stats['p95_latency_seconds'], 0)
        self.assertEqual(stats['success_rate'], 0)
        self.assertEqual(telemetry.reported_model('plain text'), 'unspecified')
        self.assertEqual(telemetry.reported_model('{"message":{"model":"reported-v1"}}'), 'reported-v1')
        task = {'attempts': [self.attempt(model=None)]}
        self.assertEqual(telemetry.build_metrics([task])['models'][0]['model'], 'unspecified')
