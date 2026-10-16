import { z } from "zod";

export const BuildStatusSchema = z.enum([
  "pending",
  "waiting_approval",
  "pending_approval",
  "assigned",
  "approved",
  "in_progress",
  "ready_for_verification",
  "verified",
  "completed",
  "failed",
  "escalated",
  "cancelled",
]);

export const TaskTokensSchema = z.strictObject({
  prompt: z.number().int().nonnegative(),
  completion: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
});

export const TaskBudgetSchema = z.strictObject({
  cap_usd: z.number().nonnegative().nullable(),
  spent_usd: z.number().nonnegative(),
  exceeded: z.boolean(),
});

export const FailureModesSchema = z.strictObject({
  quota: z.number().int().nonnegative().optional(),
  agent: z.number().int().nonnegative().optional(),
  verification: z.number().int().nonnegative().optional(),
  budget_exceeded: z.number().int().nonnegative().optional(),
  timeout: z.number().int().nonnegative().optional(),
  runtime: z.number().int().nonnegative().optional(),
});

export const TaskTelemetrySchema = z.strictObject({
  tokens: TaskTokensSchema,
  cost_usd: z.number().nonnegative(),
  duration_seconds: z.number().nonnegative(),
  agent_duration_seconds: z.number().nonnegative(),
  verification_duration_seconds: z.number().nonnegative(),
  estimated_tokens: z.boolean(),
  attempt_count: z.number().int().nonnegative(),
  failed_attempts: z.number().int().nonnegative(),
  retry_rate: z.number().min(0).max(1),
  failure_modes: FailureModesSchema,
  budget: TaskBudgetSchema,
});

export const BuildTaskSchema = z.strictObject({
  id: z.string().min(1),
  title: z.string(),
  description: z.string(),
  phase: z.string(),
  status: BuildStatusSchema,
  assigned_agent: z.string(),
  retry_count: z.number().int().nonnegative(),
  revision: z.string().regex(/^[a-f0-9]{64}$/),
  github_issue_number: z.number().int().positive().nullable(),
  closed_at: z.string().nullable(),
  commit_sha: z.string().nullable(),
  budget_cap_usd: z.number().nonnegative().nullable().optional(),
  telemetry: TaskTelemetrySchema.optional(),
  active_attempt: z
    .strictObject({
      agent: z.string(),
      phase: z.enum(["agent", "verification"]),
      started_at: z.iso.datetime({ offset: true }),
      elapsed_seconds: z.number().nonnegative(),
    })
    .nullable()
    .optional(),
});

export const BuildLogSchema = z.strictObject({
  id: z.uuid(),
  task_id: z.string(),
  source: z.enum(["orchestrator", "webhook", "dashboard"]),
  timestamp: z.string(),
  message: z.string().max(4000),
});

export const BuildMetricsBudgetSchema = z.strictObject({
  total_cap_usd: z.number().nonnegative().nullable(),
  total_spent_usd: z.number().nonnegative(),
  exceeded: z.boolean(),
});

export const AgentMetricsSchema = z.strictObject({
  agent: z.string(),
  attempt_count: z.number().int().nonnegative(),
  failed_attempts: z.number().int().nonnegative(),
  total_tokens: z.number().int().nonnegative(),
  total_cost_usd: z.number().nonnegative(),
  avg_latency_seconds: z.number().nonnegative(),
  retry_rate: z.number().min(0).max(1),
  failure_modes: FailureModesSchema,
});

export const BuildMetricsSchema = AgentMetricsSchema.omit({
  agent: true,
  failed_attempts: true,
}).extend({
  agents: z.array(AgentMetricsSchema),
  budget: BuildMetricsBudgetSchema,
});

export const BuildSnapshotSchema = z.strictObject({
  tasks: z.array(BuildTaskSchema),
  current_task_id: z.string().nullable(),
  logs: z.array(BuildLogSchema).max(200),
  metrics: BuildMetricsSchema.optional(),
});

export const BuildApprovalSchema = z.strictObject({
  revision: z.string().regex(/^[a-f0-9]{64}$/),
});

export const BuildBudgetUpdateSchema = z.strictObject({
  revision: z.string().regex(/^[a-f0-9]{64}$/),
  budget_cap_usd: z.number().nonnegative().nullable(),
});

export type BuildTask = z.infer<typeof BuildTaskSchema>;
export type BuildLog = z.infer<typeof BuildLogSchema>;
export type BuildSnapshot = z.infer<typeof BuildSnapshotSchema>;
export type TaskTokens = z.infer<typeof TaskTokensSchema>;
export type TaskBudget = z.infer<typeof TaskBudgetSchema>;
export type FailureModes = z.infer<typeof FailureModesSchema>;
export type TaskTelemetry = z.infer<typeof TaskTelemetrySchema>;
export type AgentMetrics = z.infer<typeof AgentMetricsSchema>;
export type BuildMetrics = z.infer<typeof BuildMetricsSchema>;
export type BuildMetricsBudget = z.infer<typeof BuildMetricsBudgetSchema>;
export type BuildBudgetUpdate = z.infer<typeof BuildBudgetUpdateSchema>;

export const DEFAULT_AGENT_RATES: Record<
  string,
  { prompt: number; completion: number }
> = {
  claude: { prompt: 3.0, completion: 15.0 },
  codex: { prompt: 2.5, completion: 10.0 },
  antigravity: { prompt: 0.15, completion: 0.6 },
};

export const FailureModeNames = [
  "quota",
  "agent",
  "verification",
  "budget_exceeded",
  "timeout",
  "runtime",
] as const;

export type FailureMode = (typeof FailureModeNames)[number];

export interface AgentAttemptTelemetry {
  agent: string;
  duration_seconds?: number;
  tokens?: { prompt: number; completion: number; total?: number };
  cost_usd?: number;
  estimated_tokens?: boolean;
  failure?: FailureMode | null;
}

export function calculateTokenCost(
  agent: string,
  tokens: { prompt: number; completion: number },
  rates?: Record<string, { prompt: number; completion: number }>,
): number {
  const fallback = DEFAULT_AGENT_RATES["claude"]!;
  const rate = (rates ?? DEFAULT_AGENT_RATES)[agent] ?? fallback;
  const cost =
    (tokens.prompt * rate.prompt + tokens.completion * rate.completion) /
    1_000_000;
  return Number(cost.toFixed(6));
}

export function estimateTokenUsage(
  prompt: string,
  output: string,
): {
  tokens: { prompt: number; completion: number; total: number };
  estimated: boolean;
} {
  // Check JSON usage output
  const jsonMatches = output.match(/\{[^{}]*\}/g);
  if (jsonMatches) {
    for (let i = jsonMatches.length - 1; i >= 0; i--) {
      const candidate = jsonMatches[i];
      if (!candidate) continue;
      try {
        const parsed = JSON.parse(candidate);
        const p =
          parsed.input_tokens ??
          parsed.prompt_tokens ??
          parsed.usage?.input_tokens ??
          parsed.usage?.prompt_tokens;
        const c =
          parsed.output_tokens ??
          parsed.completion_tokens ??
          parsed.usage?.output_tokens ??
          parsed.usage?.completion_tokens;
        if (
          typeof p === "number" &&
          p >= 0 &&
          typeof c === "number" &&
          c >= 0
        ) {
          return {
            tokens: { prompt: p, completion: c, total: p + c },
            estimated: false,
          };
        }
      } catch {
        // ignore malformed candidate
      }
    }
  }

  // Check structured text token reporting
  const match = output.match(
    /tokens?:\s*(\d+)\s*(?:prompt|input)[,\s]+(\d+)\s*(?:completion|output)/i,
  );
  if (match && match[1] && match[2]) {
    const p = parseInt(match[1], 10);
    const c = parseInt(match[2], 10);
    return {
      tokens: { prompt: p, completion: c, total: p + c },
      estimated: false,
    };
  }

  const totalMatch = output.match(
    /(?:total[_\s]tokens|tokens? used)\s*:?\s*([\d,]+)/i,
  );
  if (totalMatch && totalMatch[1]) {
    const total = parseInt(totalMatch[1].replace(/,/g, ""), 10);
    const p = Math.min(total, Math.ceil((prompt.length + 3) / 4));
    return {
      tokens: { prompt: p, completion: Math.max(0, total - p), total },
      estimated: true,
    };
  }

  const p = Math.ceil((prompt.length + 3) / 4);
  const c = Math.ceil((output.length + 3) / 4);
  return {
    tokens: { prompt: p, completion: c, total: p + c },
    estimated: true,
  };
}

export function aggregateBuildMetrics(
  tasks: Array<{
    telemetry?: TaskTelemetry;
    attempts?: AgentAttemptTelemetry[];
  }>,
): BuildMetrics {
  let totalTokens = 0;
  let totalCost = 0;
  let totalDuration = 0;
  let attemptsCount = 0;
  let retriesCount = 0;
  const caps: Array<number | null> = [];
  let exceeded = false;
  const failureModes: Partial<Record<FailureMode, number>> = {};
  const agentMap = new Map<
    string,
    {
      agent: string;
      attempt_count: number;
      failed_attempts: number;
      total_tokens: number;
      total_cost_usd: number;
      avg_latency_seconds: number;
      retry_rate: number;
      failure_modes: Partial<Record<FailureMode, number>>;
    }
  >();

  for (const task of tasks) {
    if (!task.telemetry) continue;
    const tel = task.telemetry;
    totalTokens += tel.tokens.total;
    totalCost += tel.cost_usd;
    totalDuration += tel.duration_seconds;
    const count = tel.attempt_count;
    attemptsCount += count;
    retriesCount += Math.max(0, count - 1);
    caps.push(tel.budget.cap_usd);
    exceeded = exceeded || tel.budget.exceeded;

    for (const [mode, cnt] of Object.entries(tel.failure_modes)) {
      if (typeof cnt === "number" && cnt > 0) {
        const k = mode as FailureMode;
        failureModes[k] = (failureModes[k] ?? 0) + cnt;
      }
    }

    if (task.attempts) {
      task.attempts.forEach((attempt, index) => {
        const agent = attempt.agent;
        if (!agentMap.has(agent)) {
          agentMap.set(agent, {
            agent,
            attempt_count: 0,
            failed_attempts: 0,
            total_tokens: 0,
            total_cost_usd: 0,
            avg_latency_seconds: 0,
            retry_rate: 0,
            failure_modes: {},
          });
        }
        const row = agentMap.get(agent)!;
        row.attempt_count += 1;
        if (attempt.failure) {
          row.failed_attempts += 1;
          row.failure_modes[attempt.failure] =
            (row.failure_modes[attempt.failure] ?? 0) + 1;
        }
        row.total_tokens += attempt.tokens?.total ?? 0;
        row.total_cost_usd += attempt.cost_usd ?? 0;
        row.avg_latency_seconds += attempt.duration_seconds ?? 0;
        if (index > 0) {
          row.retry_rate += 1;
        }
      });
    }
  }

  const agents: AgentMetrics[] = Array.from(agentMap.values()).map((row) => ({
    agent: row.agent,
    attempt_count: row.attempt_count,
    failed_attempts: row.failed_attempts,
    total_tokens: row.total_tokens,
    total_cost_usd: Number(row.total_cost_usd.toFixed(6)),
    avg_latency_seconds:
      row.attempt_count > 0
        ? Number((row.avg_latency_seconds / row.attempt_count).toFixed(3))
        : 0,
    retry_rate:
      row.attempt_count > 0
        ? Number((row.retry_rate / row.attempt_count).toFixed(4))
        : 0,
    failure_modes: row.failure_modes,
  }));
  agents.sort((a, b) => a.agent.localeCompare(b.agent));

  const allCapsSet = caps.length > 0 && caps.every((c) => c !== null);
  const totalCap = allCapsSet
    ? caps.reduce<number>((acc, c) => acc + (c as number), 0)
    : null;

  return {
    total_tokens: totalTokens,
    total_cost_usd: Number(totalCost.toFixed(6)),
    avg_latency_seconds:
      attemptsCount > 0
        ? Number((totalDuration / attemptsCount).toFixed(3))
        : 0,
    attempt_count: attemptsCount,
    retry_rate:
      attemptsCount > 0 ? Number((retriesCount / attemptsCount).toFixed(4)) : 0,
    failure_modes: failureModes,
    agents,
    budget: {
      total_cap_usd: totalCap,
      total_spent_usd: Number(totalCost.toFixed(6)),
      exceeded,
    },
  };
}

export function canApproveTask(task: BuildTask): boolean {
  return (
    !task.closed_at &&
    [
      "pending",
      "waiting_approval",
      "pending_approval",
      "failed",
      "escalated",
    ].includes(task.status)
  );
}
