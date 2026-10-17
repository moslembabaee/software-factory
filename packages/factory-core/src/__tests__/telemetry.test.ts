import { describe, expect, it } from "vitest";
import {
  extractTokenUsage,
  calculateTokenCost,
  calculateBudgetCap,
  computeTaskTelemetry,
  recordAttemptTelemetry,
  computeActiveAttempt,
  aggregateBuildMetrics,
  ValueError,
} from "../telemetry.js";
import {
  BuildMetricsSchema,
  TaskTelemetrySchema,
} from "../build.js";

describe("Agent Telemetry and Cost Analytics Pipeline", () => {
  describe("Token usage extraction", () => {
    it("extracts tokens from nested JSON reports in execution output", () => {
      const output = [
        "Starting agent execution...",
        '{"event":"step","usage":{"input_tokens":150,"output_tokens":45}}',
        '{"event":"turn.completed","usage":{"prompt_tokens":200,"completion_tokens":80}}',
      ].join("\n");

      const result = extractTokenUsage("Analyze codebase and fix bugs", output);
      expect(result.estimated).toBe(false);
      expect(result.tokens).toEqual({
        prompt: 200,
        completion: 80,
        total: 280,
      });
    });

    it("extracts tokens from plain text token reports", () => {
      const output = "Execution finished.\nTokens: 350 prompt, 50 completion\nDone.";
      const result = extractTokenUsage("test prompt", output);
      expect(result.estimated).toBe(false);
      expect(result.tokens).toEqual({
        prompt: 350,
        completion: 50,
        total: 400,
      });
    });

    it("extracts total tokens with comma formatting and marks as estimated", () => {
      const prompt = "Short prompt";
      const output = "Run summary: tokens used: 1,500";
      const result = extractTokenUsage(prompt, output);
      expect(result.estimated).toBe(true);
      expect(result.tokens.total).toBe(1500);
      expect(result.tokens.prompt).toBeLessThanOrEqual(1500);
      expect(result.tokens.prompt + result.tokens.completion).toBe(1500);
    });

    it("falls back to heuristic character estimation when no token count is present", () => {
      const prompt = "a".repeat(400); // ~100 tokens
      const output = "b".repeat(800); // ~200 tokens
      const result = extractTokenUsage(prompt, output);
      expect(result.estimated).toBe(true);
      expect(result.tokens.prompt).toBe(100);
      expect(result.tokens.completion).toBe(200);
      expect(result.tokens.total).toBe(300);
    });
  });

  describe("Cost estimation", () => {
    it("calculates cost using default agent rates", () => {
      const claudeTokens = { prompt: 100_000, completion: 50_000 };
      // Claude: prompt: $3/M, completion: $15/M
      // 100k * 3 / 1M = 0.30
      // 50k * 15 / 1M = 0.75
      // Total: 1.05
      const cost = calculateTokenCost("claude", claudeTokens);
      expect(cost).toBe(1.05);

      const codexTokens = { prompt: 100_000, completion: 50_000 };
      // Codex: prompt: $2.5/M, completion: $10/M
      // 100k * 2.5 / 1M = 0.25
      // 50k * 10 / 1M = 0.50
      // Total: 0.75
      expect(calculateTokenCost("codex", codexTokens)).toBe(0.75);

      const antigravityTokens = { prompt: 100_000, completion: 50_000 };
      // Antigravity: prompt: $0.15/M, completion: $0.60/M
      // 100k * 0.15 / 1M = 0.015
      // 50k * 0.60 / 1M = 0.030
      // Total: 0.045
      expect(calculateTokenCost("antigravity", antigravityTokens)).toBe(0.045);
    });

    it("supports custom agent rates", () => {
      const customRates = {
        custom_agent: { prompt: 5.0, completion: 20.0 },
      };
      const cost = calculateTokenCost(
        "custom_agent",
        { prompt: 200_000, completion: 100_000 },
        customRates,
      );
      // 200k * 5 / 1M = 1.0
      // 100k * 20 / 1M = 2.0
      // Total: 3.0
      expect(cost).toBe(3.0);
    });

    it("falls back to claude rates for unknown agent", () => {
      const cost = calculateTokenCost("unknown_agent", {
        prompt: 1_000_000,
        completion: 1_000_000,
      });
      expect(cost).toBe(18.0);
    });
  });

  describe("Budget caps", () => {
    it("handles explicit null (unlimited) and numbers", () => {
      expect(calculateBudgetCap({ budget_cap_usd: null })).toBeNull();
      expect(calculateBudgetCap({ budget_cap_usd: 15.5 })).toBe(15.5);
      expect(calculateBudgetCap({}, 20.0)).toBe(20.0);
      expect(calculateBudgetCap({}, null)).toBeNull();
    });

    it("rejects invalid budget cap values", () => {
      expect(() => calculateBudgetCap({ budget_cap_usd: -5 })).toThrow(
        ValueError,
      );
      expect(() => calculateBudgetCap({ budget_cap_usd: Infinity })).toThrow(
        ValueError,
      );
      expect(() =>
        calculateBudgetCap({ budget_cap_usd: "invalid" as unknown as number }),
      ).toThrow(ValueError);
    });
  });

  describe("Task telemetry computation and attempt recording", () => {
    it("computes default telemetry for empty task", () => {
      const tel = computeTaskTelemetry({});
      expect(tel.attempt_count).toBe(0);
      expect(tel.cost_usd).toBe(0);
      expect(tel.retry_rate).toBe(0);
      expect(tel.budget.exceeded).toBe(false);
      expect(tel.budget.cap_usd).toBeNull();
      expect(TaskTelemetrySchema.safeParse(tel).success).toBe(true);
    });

    it("records multiple attempts and calculates cumulative statistics", () => {
      const task = { budget_cap_usd: 0.05 };
      const attempt1 = {
        agent: "claude",
        tokens: { prompt: 1000, completion: 500, total: 1500 },
        estimated_tokens: false,
        cost_usd: 0.0105,
        duration_seconds: 12.5,
        agent_duration_seconds: 10.0,
        verification_duration_seconds: 2.5,
        failure: "timeout",
      };

      const tel1 = recordAttemptTelemetry(task, attempt1);
      expect(tel1.attempt_count).toBe(1);
      expect(tel1.failed_attempts).toBe(1);
      expect(tel1.retry_rate).toBe(0);
      expect(tel1.failure_modes.timeout).toBe(1);
      expect(tel1.cost_usd).toBe(0.0105);
      expect(tel1.budget.exceeded).toBe(false);

      const attempt2 = {
        agent: "codex",
        tokens: { prompt: 2000, completion: 1000, total: 3000 },
        estimated_tokens: true,
        cost_usd: 0.015,
        duration_seconds: 8.2,
        agent_duration_seconds: 6.0,
        verification_duration_seconds: 2.2,
        failure: null,
      };

      const tel2 = recordAttemptTelemetry(task, attempt2);
      expect(tel2.attempt_count).toBe(2);
      expect(tel2.failed_attempts).toBe(1);
      expect(tel2.retry_rate).toBe(0.5); // (2-1)/2 = 0.5
      expect(tel2.tokens.total).toBe(4500);
      expect(tel2.cost_usd).toBe(0.0255);
      expect(tel2.estimated_tokens).toBe(true);
      expect(TaskTelemetrySchema.safeParse(tel2).success).toBe(true);
    });

    it("flags budget exceeded when cumulative spend meets or exceeds cap", () => {
      const task = { budget_cap_usd: 0.01 };
      const attempt = {
        agent: "claude",
        tokens: { prompt: 2000, completion: 1000, total: 3000 },
        cost_usd: 0.021,
        duration_seconds: 10,
        agent_duration_seconds: 8,
        verification_duration_seconds: 2,
      };
      const tel = recordAttemptTelemetry(task, attempt);
      expect(tel.budget.exceeded).toBe(true);
    });
  });

  describe("Active attempt tracking", () => {
    it("returns active attempt with elapsed time for in_progress task", () => {
      const started = new Date(Date.now() - 5000).toISOString();
      const task = {
        status: "in_progress",
        active_attempt: {
          agent: "claude",
          phase: "agent" as const,
          started_at: started,
        },
      };

      const active = computeActiveAttempt(task);
      expect(active).not.toBeNull();
      expect(active?.agent).toBe("claude");
      expect(active?.phase).toBe("agent");
      expect(active?.elapsed_seconds).toBeGreaterThanOrEqual(4.9);
    });

    it("returns null for closed or pending tasks", () => {
      const started = new Date().toISOString();
      expect(
        computeActiveAttempt({
          status: "pending",
          active_attempt: {
            agent: "claude",
            phase: "agent",
            started_at: started,
          },
        }),
      ).toBeNull();

      expect(
        computeActiveAttempt({
          status: "in_progress",
          closed_at: started,
          active_attempt: {
            agent: "claude",
            phase: "agent",
            started_at: started,
          },
        }),
      ).toBeNull();
    });
  });

  describe("Aggregate build metrics", () => {
    it("aggregates metrics across multiple tasks and breakdowns by agent", () => {
      const task1Tel = computeTaskTelemetry({
        telemetry: {
          tokens: { prompt: 1000, completion: 500, total: 1500 },
          cost_usd: 0.0105,
          duration_seconds: 10,
          failure_modes: { timeout: 1 },
          budget: { cap_usd: 0.05, spent_usd: 0.0105, exceeded: false },
        },
        attempts: [
          {
            agent: "claude",
            tokens: { prompt: 1000, completion: 500, total: 1500 },
            cost_usd: 0.0105,
            duration_seconds: 10,
            agent_duration_seconds: 8,
            verification_duration_seconds: 2,
            failure: "timeout",
          },
        ],
      });

      const task2Tel = computeTaskTelemetry({
        telemetry: {
          tokens: { prompt: 2000, completion: 1000, total: 3000 },
          cost_usd: 0.015,
          duration_seconds: 20,
          failure_modes: { agent: 1 },
          budget: { cap_usd: 0.05, spent_usd: 0.015, exceeded: false },
        },
        attempts: [
          {
            agent: "claude",
            tokens: { prompt: 1000, completion: 500, total: 1500 },
            cost_usd: 0.0075,
            duration_seconds: 10,
            agent_duration_seconds: 8,
            verification_duration_seconds: 2,
            failure: "agent",
          },
          {
            agent: "codex",
            tokens: { prompt: 1000, completion: 500, total: 1500 },
            cost_usd: 0.0075,
            duration_seconds: 10,
            agent_duration_seconds: 8,
            verification_duration_seconds: 2,
            failure: null,
          },
        ],
      });

      const metrics = aggregateBuildMetrics([
        {
          telemetry: task1Tel,
          attempts: [
            {
              agent: "claude",
              tokens: { prompt: 1000, completion: 500, total: 1500 },
              cost_usd: 0.0105,
              duration_seconds: 10,
              agent_duration_seconds: 8,
              verification_duration_seconds: 2,
              failure: "timeout",
            },
          ],
        },
        {
          telemetry: task2Tel,
          attempts: [
            {
              agent: "claude",
              tokens: { prompt: 1000, completion: 500, total: 1500 },
              cost_usd: 0.0075,
              duration_seconds: 10,
              agent_duration_seconds: 8,
              verification_duration_seconds: 2,
              failure: "agent",
            },
            {
              agent: "codex",
              tokens: { prompt: 1000, completion: 500, total: 1500 },
              cost_usd: 0.0075,
              duration_seconds: 10,
              agent_duration_seconds: 8,
              verification_duration_seconds: 2,
              failure: null,
            },
          ],
        },
      ]);

      expect(metrics.total_tokens).toBe(4500);
      expect(metrics.total_cost_usd).toBe(0.0255);
      expect(metrics.attempt_count).toBe(3);
      expect(metrics.avg_latency_seconds).toBe(10);
      expect(metrics.failure_modes).toEqual({ timeout: 1, agent: 1 });
      expect(metrics.budget.total_cap_usd).toBe(0.1);
      expect(metrics.budget.exceeded).toBe(false);

      expect(metrics.agents).toHaveLength(2);
      const claude = metrics.agents.find((a) => a.agent === "claude");
      expect(claude?.attempt_count).toBe(2);
      expect(claude?.failed_attempts).toBe(2);

      const codex = metrics.agents.find((a) => a.agent === "codex");
      expect(codex?.attempt_count).toBe(1);
      expect(codex?.failed_attempts).toBe(0);

      // Validate against Zod schema
      expect(BuildMetricsSchema.safeParse(metrics).success).toBe(true);
    });

    it("handles empty task list gracefully without NaN", () => {
      const metrics = aggregateBuildMetrics([]);
      expect(metrics.total_tokens).toBe(0);
      expect(metrics.total_cost_usd).toBe(0);
      expect(metrics.avg_latency_seconds).toBe(0);
      expect(metrics.retry_rate).toBe(0);
      expect(metrics.agents).toEqual([]);
      expect(metrics.budget.total_cap_usd).toBeNull();
      expect(BuildMetricsSchema.safeParse(metrics).success).toBe(true);
    });
  });
});
