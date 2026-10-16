import { describe, expect, it } from "vitest";
import {
  AgentMetricsSchema,
  BuildMetricsSchema,
  DEFAULT_AGENT_RATES,
  FailureModesSchema,
  TaskBudgetSchema,
  TaskTelemetrySchema,
  TaskTokensSchema,
  aggregateBuildMetrics,
  calculateTokenCost,
  estimateTokenUsage,
} from "../index.js";

describe("Agent Telemetry and Cost Analytics Pipeline", () => {
  it("validates token, budget, failure modes, and telemetry schemas", () => {
    expect(DEFAULT_AGENT_RATES["claude"]?.prompt).toBe(3.0);
    const tokens = { prompt: 1500, completion: 450, total: 1950 };
    expect(TaskTokensSchema.parse(tokens)).toEqual(tokens);

    const budget = { cap_usd: 5.0, spent_usd: 0.125, exceeded: false };
    expect(TaskBudgetSchema.parse(budget)).toEqual(budget);

    const failureModes = { quota: 1, agent: 2, timeout: 0 };
    expect(FailureModesSchema.parse(failureModes)).toEqual(failureModes);

    const agentMetric = {
      agent: "claude",
      attempt_count: 1,
      failed_attempts: 0,
      total_tokens: 1950,
      total_cost_usd: 0.01125,
      avg_latency_seconds: 12.5,
      retry_rate: 0,
      failure_modes: failureModes,
    };
    expect(AgentMetricsSchema.parse(agentMetric)).toEqual(agentMetric);

    const telemetry = {
      tokens,
      cost_usd: 0.01125,
      duration_seconds: 12.5,
      agent_duration_seconds: 10.2,
      verification_duration_seconds: 2.3,
      estimated_tokens: false,
      attempt_count: 2,
      failed_attempts: 1,
      retry_rate: 0.5,
      failure_modes: failureModes,
      budget,
    };
    expect(TaskTelemetrySchema.parse(telemetry)).toEqual(telemetry);
  });

  it("calculates accurate token costs using default and custom agent rates", () => {
    // Claude rates: $3 prompt, $15 completion per 1M tokens
    const claudeCost = calculateTokenCost("claude", {
      prompt: 100_000,
      completion: 10_000,
    });
    // (100000 * 3 + 10000 * 15) / 1000000 = (300000 + 150000) / 1000000 = 0.45
    expect(claudeCost).toBe(0.45);

    // Codex rates: $2.50 prompt, $10 completion per 1M tokens
    const codexCost = calculateTokenCost("codex", {
      prompt: 1_000_000,
      completion: 100_000,
    });
    // (1000000 * 2.5 + 100000 * 10) / 1000000 = 3.5
    expect(codexCost).toBe(3.5);

    // Antigravity rates: $0.15 prompt, $0.60 completion per 1M tokens
    const agCost = calculateTokenCost("antigravity", {
      prompt: 1_000_000,
      completion: 1_000_000,
    });
    // (0.15 + 0.60) = 0.75
    expect(agCost).toBe(0.75);

    // Unknown agent falls back to claude rate
    const fallbackCost = calculateTokenCost("unknown-agent", {
      prompt: 100_000,
      completion: 10_000,
    });
    expect(fallbackCost).toBe(0.45);

    // Custom rates
    const customRates = {
      custom: { prompt: 1.0, completion: 2.0 },
    };
    const customCost = calculateTokenCost(
      "custom",
      { prompt: 500_000, completion: 250_000 },
      customRates,
    );
    // (500000*1 + 250000*2) / 1M = 1.0
    expect(customCost).toBe(1.0);
  });

  it("extracts token counts from structured JSON output or falls back to heuristics", () => {
    // Exact JSON usage output
    const jsonOutput = JSON.stringify({
      usage: { prompt_tokens: 420, completion_tokens: 88 },
    });
    const parsedJson = estimateTokenUsage("test prompt", jsonOutput);
    expect(parsedJson.estimated).toBe(false);
    expect(parsedJson.tokens).toEqual({
      prompt: 420,
      completion: 88,
      total: 508,
    });

    // Formatted text usage
    const textOutput = "Agent finished. Tokens: 350 prompt, 120 completion.";
    const parsedText = estimateTokenUsage("test prompt", textOutput);
    expect(parsedText.estimated).toBe(false);
    expect(parsedText.tokens).toEqual({
      prompt: 350,
      completion: 120,
      total: 470,
    });

    // Total tokens used format
    const totalOutput = "Session summary: total_tokens: 1,500";
    const parsedTotal = estimateTokenUsage("a".repeat(400), totalOutput);
    expect(parsedTotal.estimated).toBe(true);
    expect(parsedTotal.tokens.total).toBe(1500);
    expect(parsedTotal.tokens.prompt).toBe(101);
    expect(parsedTotal.tokens.completion).toBe(1399);

    // Pure heuristic estimation when no usage string is present
    const rawOutput = "Just some standard agent code output.";
    const rawPrompt = "Write a function.";
    const heuristic = estimateTokenUsage(rawPrompt, rawOutput);
    expect(heuristic.estimated).toBe(true);
    expect(heuristic.tokens.prompt).toBe(Math.ceil((rawPrompt.length + 3) / 4));
    expect(heuristic.tokens.completion).toBe(
      Math.ceil((rawOutput.length + 3) / 4),
    );
  });

  it("aggregates multi-task and multi-agent metrics accurately", () => {
    const task1 = {
      telemetry: {
        tokens: { prompt: 1000, completion: 500, total: 1500 },
        cost_usd: 0.0105,
        duration_seconds: 15.0,
        agent_duration_seconds: 12.0,
        verification_duration_seconds: 3.0,
        estimated_tokens: false,
        attempt_count: 2,
        failed_attempts: 1,
        retry_rate: 0.5,
        failure_modes: { agent: 1 },
        budget: { cap_usd: 1.0, spent_usd: 0.0105, exceeded: false },
      },
      attempts: [
        {
          agent: "claude",
          duration_seconds: 8.0,
          tokens: { prompt: 600, completion: 200, total: 800 },
          cost_usd: 0.0048,
          failure: "agent" as const,
        },
        {
          agent: "codex",
          duration_seconds: 7.0,
          tokens: { prompt: 400, completion: 300, total: 700 },
          cost_usd: 0.004,
          failure: null,
        },
      ],
    };

    const task2 = {
      telemetry: {
        tokens: { prompt: 2000, completion: 1000, total: 3000 },
        cost_usd: 0.021,
        duration_seconds: 25.0,
        agent_duration_seconds: 20.0,
        verification_duration_seconds: 5.0,
        estimated_tokens: false,
        attempt_count: 1,
        failed_attempts: 0,
        retry_rate: 0.0,
        failure_modes: {},
        budget: { cap_usd: 2.0, spent_usd: 0.021, exceeded: false },
      },
      attempts: [
        {
          agent: "claude",
          duration_seconds: 25.0,
          tokens: { prompt: 2000, completion: 1000, total: 3000 },
          cost_usd: 0.021,
          failure: null,
        },
      ],
    };

    const metrics = aggregateBuildMetrics([task1, task2]);

    expect(metrics.total_tokens).toBe(4500);
    expect(metrics.total_cost_usd).toBe(0.0315);
    expect(metrics.attempt_count).toBe(3);
    // (1 retry in task1 + 0 retries in task2) / 3 attempts = 1/3 ~ 0.3333
    expect(metrics.retry_rate).toBe(0.3333);
    // (15.0 + 25.0) / 3 = 13.333
    expect(metrics.avg_latency_seconds).toBe(13.333);
    expect(metrics.failure_modes).toEqual({ agent: 1 });
    expect(metrics.budget).toEqual({
      total_cap_usd: 3.0,
      total_spent_usd: 0.0315,
      exceeded: false,
    });

    // Check per-agent statistics
    expect(metrics.agents).toHaveLength(2);
    const claudeAgent = metrics.agents.find((a) => a.agent === "claude");
    expect(claudeAgent).toBeDefined();
    expect(claudeAgent?.attempt_count).toBe(2);
    expect(claudeAgent?.failed_attempts).toBe(1);
    expect(claudeAgent?.total_tokens).toBe(3800);
    expect(claudeAgent?.failure_modes).toEqual({ agent: 1 });

    const codexAgent = metrics.agents.find((a) => a.agent === "codex");
    expect(codexAgent).toBeDefined();
    expect(codexAgent?.attempt_count).toBe(1);
    expect(codexAgent?.failed_attempts).toBe(0);
    expect(codexAgent?.total_tokens).toBe(700);
    expect(codexAgent?.retry_rate).toBe(1.0); // 2nd attempt in task1

    // Validates against BuildMetricsSchema
    expect(() => BuildMetricsSchema.parse(metrics)).not.toThrow();
  });

  it("handles empty tasks safely without NaN or infinite values", () => {
    const emptyMetrics = aggregateBuildMetrics([]);
    expect(emptyMetrics).toEqual({
      total_tokens: 0,
      total_cost_usd: 0,
      avg_latency_seconds: 0,
      attempt_count: 0,
      retry_rate: 0,
      failure_modes: {},
      agents: [],
      budget: {
        total_cap_usd: null,
        total_spent_usd: 0,
        exceeded: false,
      },
    });
    expect(() => BuildMetricsSchema.parse(emptyMetrics)).not.toThrow();
  });
});
