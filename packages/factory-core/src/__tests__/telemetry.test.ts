import { describe, expect, it } from "vitest";
import {
  calculateTokenCost,
  computeActiveAttempt,
  computeBuildMetrics,
  computeTaskTelemetry,
  enforceBudget,
  parseTokenUsage,
  recordAttemptTelemetry,
  validateBudgetCap,
} from "../telemetry.js";
import { TaskTelemetrySchema, BuildMetricsSchema } from "../build.js";

describe("Telemetry and Token Accounting", () => {
  describe("parseTokenUsage", () => {
    it("parses single JSON usage block", () => {
      const output = '{"input_tokens": 120, "output_tokens": 30}';
      const result = parseTokenUsage("short prompt", output);
      expect(result.estimated).toBe(false);
      expect(result.tokens).toEqual({
        prompt: 120,
        completion: 30,
        total: 150,
      });
    });

    it("parses nested usage object and takes the latest cumulative candidate", () => {
      const output = [
        '{"type": "turn", "usage": {"input_tokens": 50, "output_tokens": 10}}',
        '{"type": "turn.completed", "usage": {"input_tokens": 200, "output_tokens": 60}}',
      ].join("\n");
      const result = parseTokenUsage("prompt", output);
      expect(result.estimated).toBe(false);
      expect(result.tokens).toEqual({
        prompt: 200,
        completion: 60,
        total: 260,
      });
    });

    it("parses CLI formatted text strings", () => {
      const text1 = "Execution complete. Tokens: 450 prompt, 120 completion";
      const res1 = parseTokenUsage("some prompt", text1);
      expect(res1.estimated).toBe(false);
      expect(res1.tokens).toEqual({
        prompt: 450,
        completion: 120,
        total: 570,
      });

      const text2 = "tokens: 50 completion, 300 input";
      const res2 = parseTokenUsage("some prompt", text2);
      expect(res2.estimated).toBe(false);
      expect(res2.tokens).toEqual({
        prompt: 300,
        completion: 50,
        total: 350,
      });
    });

    it("parses total tokens text reports and estimates prompt/completion", () => {
      const text = "tokens used: 1,200";
      const prompt = "a".repeat(400); // 100 estimated tokens
      const result = parseTokenUsage(prompt, text);
      expect(result.estimated).toBe(true);
      expect(result.tokens.total).toBe(1200);
      expect(result.tokens.prompt).toBe(100);
      expect(result.tokens.completion).toBe(1100);
    });

    it("falls back to character heuristic on malformed output", () => {
      const prompt = "hello world"; // 14 chars -> ~3 tokens
      const output = "failed with unexpected crash"; // 28 chars -> ~7 tokens
      const result = parseTokenUsage(prompt, output);
      expect(result.estimated).toBe(true);
      expect(result.tokens.prompt).toBe(3);
      expect(result.tokens.completion).toBe(7);
      expect(result.tokens.total).toBe(10);
    });
  });

  describe("calculateTokenCost", () => {
    it("calculates cost using configured and default agent rates", () => {
      const tokens = { prompt: 10_000, completion: 2_000, total: 12_000 };
      // claude: $3.00/M prompt, $15.00/M completion
      // (10_000 * 3.00 + 2_000 * 15.00) / 1_000_000 = (30_000 + 30_000) / 1_000_000 = 0.06
      expect(calculateTokenCost("claude", tokens)).toBe(0.06);

      // antigravity: $0.15/M prompt, $0.60/M completion
      // (10_000 * 0.15 + 2_000 * 0.60) / 1_000_000 = (1_500 + 1_200) / 1_000_000 = 0.0027
      expect(calculateTokenCost("antigravity", tokens)).toBe(0.0027);

      // Custom rates
      const customRates = { custom: { prompt: 1.0, completion: 2.0 } };
      expect(calculateTokenCost("custom", tokens, customRates)).toBe(0.014);

      // Zero tokens
      expect(calculateTokenCost("claude", { prompt: 0, completion: 0, total: 0 })).toBe(0);
    });
  });

  describe("validateBudgetCap", () => {
    it("validates finite nonnegative caps and handles explicit null", () => {
      expect(validateBudgetCap({ budget_cap_usd: 5.5 })).toBe(5.5);
      expect(validateBudgetCap({ budget_cap_usd: 0 })).toBe(0);
      expect(validateBudgetCap({ budget_cap_usd: null }, 10)).toBe(null);
      expect(validateBudgetCap({}, 10)).toBe(10);
      expect(validateBudgetCap({})).toBe(null);
    });

    it("rejects negative, non-finite, or invalid types", () => {
      expect(() => validateBudgetCap({ budget_cap_usd: -1 })).toThrow(TypeError);
      expect(() => validateBudgetCap({ budget_cap_usd: Number.NaN })).toThrow(TypeError);
      expect(() => validateBudgetCap({ budget_cap_usd: Number.POSITIVE_INFINITY })).toThrow(TypeError);
      expect(() => validateBudgetCap({ budget_cap_usd: true })).toThrow(TypeError);
      expect(() => validateBudgetCap({ budget_cap_usd: "10" })).toThrow(TypeError);
    });
  });

  describe("computeTaskTelemetry and recordAttemptTelemetry", () => {
    it("computes clean initial task telemetry and validates schema", () => {
      const task = {
        budget_cap_usd: 1.5,
        telemetry: null,
        attempts: [],
      };
      const telemetry = computeTaskTelemetry(task);
      expect(TaskTelemetrySchema.safeParse(telemetry).success).toBe(true);
      expect(telemetry.attempt_count).toBe(0);
      expect(telemetry.failed_attempts).toBe(0);
      expect(telemetry.retry_rate).toBe(0);
      expect(telemetry.cost_usd).toBe(0);
      expect(telemetry.budget.cap_usd).toBe(1.5);
      expect(telemetry.budget.spent_usd).toBe(0);
      expect(telemetry.budget.exceeded).toBe(false);
    });

    it("records attempts and accumulates metrics properly", () => {
      const task: Record<string, unknown> = {
        budget_cap_usd: 0.05,
      };

      const attempt1 = {
        agent: "claude",
        tokens: { prompt: 1000, completion: 200, total: 1200 },
        cost_usd: 0.006,
        duration_seconds: 5.2,
        agent_duration_seconds: 4.1,
        verification_duration_seconds: 1.1,
        estimated_tokens: false,
        failure: "verification",
      };

      const t1 = recordAttemptTelemetry(task, attempt1);
      expect(t1.attempt_count).toBe(1);
      expect(t1.failed_attempts).toBe(1);
      expect(t1.tokens.total).toBe(1200);
      expect(t1.cost_usd).toBe(0.006);
      expect(t1.failure_modes.verification).toBe(1);
      expect(t1.retry_rate).toBe(0);
      expect(t1.budget.exceeded).toBe(false);

      const attempt2 = {
        agent: "codex",
        tokens: { prompt: 2000, completion: 500, total: 2500 },
        cost_usd: 0.01,
        duration_seconds: 4.0,
        agent_duration_seconds: 3.0,
        verification_duration_seconds: 1.0,
        estimated_tokens: false,
        failure: null,
      };

      const t2 = recordAttemptTelemetry(task, attempt2);
      expect(t2.attempt_count).toBe(2);
      expect(t2.failed_attempts).toBe(1);
      expect(t2.tokens.total).toBe(3700);
      expect(t2.cost_usd).toBe(0.016);
      expect(t2.retry_rate).toBe(0.5); // (2 - 1) / 2
      expect(t2.budget.exceeded).toBe(false);
    });
  });

  describe("computeActiveAttempt", () => {
    it("returns elapsed time for in_progress task", () => {
      const now = new Date("2026-10-17T03:00:15.000Z");
      const task = {
        status: "in_progress",
        active_attempt: {
          agent: "claude",
          phase: "agent",
          started_at: "2026-10-17T03:00:00.000Z",
        },
      };

      const active = computeActiveAttempt(task, now);
      expect(active).not.toBeNull();
      expect(active?.agent).toBe("claude");
      expect(active?.phase).toBe("agent");
      expect(active?.elapsed_seconds).toBe(15);
    });

    it("returns null for closed or completed tasks", () => {
      const task = {
        status: "completed",
        closed_at: "2026-10-17T03:00:00.000Z",
        active_attempt: {
          agent: "claude",
          phase: "agent",
          started_at: "2026-10-17T03:00:00.000Z",
        },
      };
      expect(computeActiveAttempt(task)).toBeNull();
    });
  });

  describe("computeBuildMetrics", () => {
    it("handles empty task list without NaN or fictitious cap", () => {
      const metrics = computeBuildMetrics([]);
      expect(BuildMetricsSchema.safeParse(metrics).success).toBe(true);
      expect(metrics.total_tokens).toBe(0);
      expect(metrics.total_cost_usd).toBe(0);
      expect(metrics.avg_latency_seconds).toBe(0);
      expect(metrics.attempt_count).toBe(0);
      expect(metrics.retry_rate).toBe(0);
      expect(metrics.budget.total_cap_usd).toBeNull();
      expect(metrics.budget.exceeded).toBe(false);
      expect(metrics.agents).toHaveLength(0);
    });

    it("aggregates multiple tasks and computes per-agent performance breakdowns", () => {
      const task1 = {
        id: "T-01",
        budget_cap_usd: 1.0,
        attempts: [
          {
            agent: "claude",
            tokens: { prompt: 1000, completion: 200, total: 1200 },
            cost_usd: 0.006,
            duration_seconds: 4.0,
            failure: "agent",
          },
          {
            agent: "codex",
            tokens: { prompt: 800, completion: 150, total: 950 },
            cost_usd: 0.0035,
            duration_seconds: 3.0,
            failure: null,
          },
        ],
        telemetry: {
          tokens: { prompt: 1800, completion: 350, total: 2150 },
          cost_usd: 0.0095,
          duration_seconds: 7.0,
          attempt_count: 2,
          failed_attempts: 1,
          retry_rate: 0.5,
          failure_modes: { agent: 1 },
          budget: { cap_usd: 1.0, spent_usd: 0.0095, exceeded: false },
        },
      };

      const task2 = {
        id: "T-02",
        budget_cap_usd: 2.0,
        attempts: [
          {
            agent: "claude",
            tokens: { prompt: 500, completion: 100, total: 600 },
            cost_usd: 0.003,
            duration_seconds: 2.0,
            failure: null,
          },
        ],
        telemetry: {
          tokens: { prompt: 500, completion: 100, total: 600 },
          cost_usd: 0.003,
          duration_seconds: 2.0,
          attempt_count: 1,
          failed_attempts: 0,
          retry_rate: 0,
          failure_modes: {},
          budget: { cap_usd: 2.0, spent_usd: 0.003, exceeded: false },
        },
      };

      const metrics = computeBuildMetrics([task1, task2]);
      expect(BuildMetricsSchema.safeParse(metrics).success).toBe(true);

      expect(metrics.total_tokens).toBe(2750);
      expect(metrics.total_cost_usd).toBe(0.0125);
      expect(metrics.attempt_count).toBe(3);
      expect(metrics.retry_rate).toBeCloseTo(1 / 3, 4);
      expect(metrics.avg_latency_seconds).toBe(3.0);
      expect(metrics.budget.total_cap_usd).toBe(3.0);
      expect(metrics.budget.exceeded).toBe(false);
      expect(metrics.failure_modes.agent).toBe(1);

      expect(metrics.agents).toHaveLength(2);
      const claude = metrics.agents.find((a) => a.agent === "claude");
      expect(claude?.attempt_count).toBe(2);
      expect(claude?.failed_attempts).toBe(1);
      expect(claude?.total_tokens).toBe(1800);
      expect(claude?.total_cost_usd).toBe(0.009);
      expect(claude?.avg_latency_seconds).toBe(3.0);
      expect(claude?.retry_rate).toBe(0); // neither claude attempt was index > 0 in its task

      const codex = metrics.agents.find((a) => a.agent === "codex");
      expect(codex?.attempt_count).toBe(1);
      expect(codex?.failed_attempts).toBe(0);
      expect(codex?.total_tokens).toBe(950);
      expect(codex?.total_cost_usd).toBe(0.0035);
      expect(codex?.retry_rate).toBe(1.0); // codex was attempt index 1 in task1
    });
  });

  describe("enforceBudget", () => {
    it("allows execution when within cap", () => {
      const task = {
        budget_cap_usd: 0.05,
        telemetry: {
          cost_usd: 0.02,
          budget: { cap_usd: 0.05, spent_usd: 0.02, exceeded: false },
        },
      };
      const check = enforceBudget(task, 0.01);
      expect(check.allowed).toBe(true);
      expect(check.exceeded).toBe(false);
      expect(check.projected_usd).toBe(0.03);
    });

    it("blocks execution when cap would be exceeded", () => {
      const task = {
        budget_cap_usd: 0.05,
        telemetry: {
          cost_usd: 0.04,
          budget: { cap_usd: 0.05, spent_usd: 0.04, exceeded: false },
        },
      };
      const check = enforceBudget(task, 0.02);
      expect(check.allowed).toBe(false);
      expect(check.exceeded).toBe(true);
      expect(check.projected_usd).toBe(0.06);
      expect(check.reason).toBe("Budget limit exceeded");
    });
  });
});
