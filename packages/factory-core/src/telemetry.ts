import {
  type BuildMetrics,
  type BuildMetricsBudget,
  type FailureModes,
  type TaskTelemetry,
  type TaskTokens,
  type AgentMetrics,
  BuildMetricsSchema,
  TaskTelemetrySchema,
} from "./build.js";

export const DEFAULT_AGENT_RATES: Record<
  string,
  { prompt: number; completion: number }
> = {
  claude: { prompt: 3.0, completion: 15.0 },
  "claude-sonnet": { prompt: 3.0, completion: 15.0 },
  "claude-opus": { prompt: 15.0, completion: 75.0 },
  "claude-haiku": { prompt: 0.8, completion: 4.0 },
  sonnet: { prompt: 3.0, completion: 15.0 },
  opus: { prompt: 15.0, completion: 75.0 },
  haiku: { prompt: 0.8, completion: 4.0 },
  codex: { prompt: 2.5, completion: 10.0 },
  antigravity: { prompt: 0.15, completion: 0.6 },
  gemini: { prompt: 0.15, completion: 0.6 },
};

export const FAILURE_MODES = [
  "quota",
  "agent",
  "verification",
  "budget_exceeded",
  "timeout",
  "runtime",
] as const;

export type FailureMode = (typeof FAILURE_MODES)[number];

export function nonnegative(value: unknown, defaultValue = 0): number {
  return typeof value === "number" &&
    !Number.isNaN(value) &&
    Number.isFinite(value) &&
    value >= 0
    ? value
    : defaultValue;
}

export function parseTokenUsage(
  prompt: string,
  output: string,
): { tokens: TaskTokens; estimated: boolean } {
  const candidates: Array<{ prompt: number; completion: number }> = [];

  // Match JSON objects in output
  let pos = 0;
  while ((pos = output.indexOf("{", pos)) !== -1) {
    let braceCount = 0;
    let endPos = -1;
    for (let i = pos; i < output.length; i++) {
      if (output[i] === "{") braceCount++;
      else if (output[i] === "}") {
        braceCount--;
        if (braceCount === 0) {
          endPos = i + 1;
          break;
        }
      }
    }
    if (endPos === -1) break;

    const slice = output.slice(pos, endPos);
    try {
      const parsed: unknown = JSON.parse(slice);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const obj = parsed as Record<string, unknown>;
        let p = obj["input_tokens"] ?? obj["prompt_tokens"];
        let c = obj["output_tokens"] ?? obj["completion_tokens"];

        const usageObj = obj["usage"];
        if (
          typeof p !== "number" &&
          usageObj &&
          typeof usageObj === "object" &&
          !Array.isArray(usageObj)
        ) {
          const u = usageObj as Record<string, unknown>;
          p = u["input_tokens"] ?? u["prompt_tokens"];
          c = u["output_tokens"] ?? u["completion_tokens"];
        }

        if (
          typeof p === "number" &&
          p >= 0 &&
          typeof c === "number" &&
          c >= 0
        ) {
          candidates.push({ prompt: p, completion: c });
        }
      }
    } catch {
      // invalid JSON slice, continue
    }
    pos++;
  }

  if (candidates.length > 0) {
    const last = candidates[candidates.length - 1];
    if (last) {
      return {
        tokens: {
          prompt: last.prompt,
          completion: last.completion,
          total: last.prompt + last.completion,
        },
        estimated: false,
      };
    }
  }

  // Regex text search: tokens: X prompt, Y completion
  const regexPromptCompletion =
    /tokens?:\s*(\d+)\s*(?:prompt|input)[,\s]+(\d+)\s*(?:completion|output)/i.exec(
      output,
    );
  if (regexPromptCompletion) {
    const promptCount = parseInt(regexPromptCompletion[1] ?? "0", 10);
    const completionCount = parseInt(regexPromptCompletion[2] ?? "0", 10);
    return {
      tokens: {
        prompt: promptCount,
        completion: completionCount,
        total: promptCount + completionCount,
      },
      estimated: false,
    };
  }

  // Regex text search: tokens: Y completion, X prompt
  const regexCompletionPrompt =
    /tokens?:\s*(\d+)\s*(?:completion|output)[,\s]+(\d+)\s*(?:prompt|input)/i.exec(
      output,
    );
  if (regexCompletionPrompt) {
    const completionCount = parseInt(regexCompletionPrompt[1] ?? "0", 10);
    const promptCount = parseInt(regexCompletionPrompt[2] ?? "0", 10);
    return {
      tokens: {
        prompt: promptCount,
        completion: completionCount,
        total: promptCount + completionCount,
      },
      estimated: false,
    };
  }

  // Regex text search: input_tokens: X, output_tokens: Y
  const regexTokensSplit =
    /(?:input|prompt)[_\s]tokens?:\s*(\d+)[,\s]+(?:output|completion)[_\s]tokens?:\s*(\d+)/i.exec(
      output,
    );
  if (regexTokensSplit) {
    const promptCount = parseInt(regexTokensSplit[1] ?? "0", 10);
    const completionCount = parseInt(regexTokensSplit[2] ?? "0", 10);
    return {
      tokens: {
        prompt: promptCount,
        completion: completionCount,
        total: promptCount + completionCount,
      },
      estimated: false,
    };
  }

  // Regex text search: total_tokens: Z or tokens used: Z
  const regexTotal = /(?:total[_\s]tokens|tokens? used)\s*:?\s*([\d,]+)/i.exec(
    output,
  );
  if (regexTotal?.[1]) {
    const total = parseInt(regexTotal[1].replaceAll(",", ""), 10);
    const promptEst = Math.min(total, Math.floor((prompt.length + 3) / 4));
    const completionEst = Math.max(0, total - promptEst);
    return {
      tokens: {
        prompt: promptEst,
        completion: completionEst,
        total,
      },
      estimated: true,
    };
  }

  // Fallback heuristic: 1 token ~ 4 characters
  const promptEst = Math.floor((prompt.length + 3) / 4);
  const completionEst = Math.floor((output.length + 3) / 4);
  return {
    tokens: {
      prompt: promptEst,
      completion: completionEst,
      total: promptEst + completionEst,
    },
    estimated: true,
  };
}

export function calculateTokenCost(
  agent: string,
  tokens: TaskTokens,
  rates?: Record<string, { prompt: number; completion: number }>,
): number {
  const rateTable = rates ?? DEFAULT_AGENT_RATES;
  const rate =
    rateTable[agent] ?? rateTable["claude"] ?? { prompt: 3.0, completion: 15.0 };
  const cost =
    (tokens.prompt * rate.prompt + tokens.completion * rate.completion) /
    1_000_000;
  return Math.round(cost * 1_000_000) / 1_000_000;
}

export function validateBudgetCap(
  task: { budget_cap_usd?: unknown },
  defaultCap?: number | null,
): number | null {
  const value =
    task.budget_cap_usd !== undefined ? task.budget_cap_usd : defaultCap;
  if (value === null || value === undefined) return null;
  if (
    typeof value !== "number" ||
    Number.isNaN(value) ||
    !Number.isFinite(value) ||
    value < 0
  ) {
    throw new TypeError("budget_cap_usd must be finite and nonnegative");
  }
  return value;
}

export interface TaskTelemetryInput {
  budget_cap_usd?: unknown;
  telemetry?: Partial<TaskTelemetry> | Record<string, unknown> | null;
  attempts?: Array<Record<string, unknown>>;
  [key: string]: unknown;
}

export function computeTaskTelemetry(
  task: TaskTelemetryInput,
  defaultCap?: number | null,
): TaskTelemetry {
  const raw = (task.telemetry ?? {}) as Record<string, unknown>;
  const attempts = task.attempts ?? [];
  const count = attempts.length;

  const rawTokens = raw["tokens"] as Record<string, unknown> | undefined;
  const prompt = Math.floor(nonnegative(rawTokens?.["prompt"]));
  const completion = Math.floor(nonnegative(rawTokens?.["completion"]));
  const spent = nonnegative(raw["cost_usd"]);

  const rawBudget = raw["budget"] as Record<string, unknown> | undefined;
  const inheritedCap =
    defaultCap !== undefined
      ? defaultCap
      : typeof rawBudget?.["cap_usd"] === "number" || rawBudget?.["cap_usd"] === null
        ? rawBudget["cap_usd"]
        : null;
  const cap = validateBudgetCap(task, inheritedCap);

  const failureModes: FailureModes = {};
  if (raw["failure_modes"] && typeof raw["failure_modes"] === "object") {
    const rawModes = raw["failure_modes"] as Record<string, unknown>;
    for (const key of FAILURE_MODES) {
      const v = rawModes[key];
      if (typeof v === "number" && v > 0) {
        failureModes[key] = Math.floor(nonnegative(v));
      }
    }
  }

  const durationSeconds = nonnegative(raw["duration_seconds"]);
  const agentDuration = nonnegative(raw["agent_duration_seconds"]);
  const verifyDuration = nonnegative(raw["verification_duration_seconds"]);

  const failedAttempts = attempts.filter((a) => Boolean(a["failure"])).length;
  const retryRate =
    count > 0
      ? Math.round((Math.max(0, count - 1) / count) * 10_000) / 10_000
      : 0;

  const result: TaskTelemetry = {
    tokens: {
      prompt,
      completion,
      total: prompt + completion,
    },
    estimated_tokens: Boolean(raw["estimated_tokens"]),
    cost_usd: spent,
    duration_seconds: durationSeconds,
    agent_duration_seconds: agentDuration,
    verification_duration_seconds: verifyDuration,
    attempt_count: count,
    failed_attempts: failedAttempts,
    retry_rate: retryRate,
    failure_modes: failureModes,
    budget: {
      cap_usd: cap,
      spent_usd: spent,
      exceeded: cap !== null && spent >= cap,
    },
  };

  return TaskTelemetrySchema.parse(result);
}

export function recordAttemptTelemetry(
  task: Record<string, unknown>,
  attempt: Record<string, unknown>,
  defaultCap?: number | null,
): TaskTelemetry {
  const telemetry = computeTaskTelemetry(task, defaultCap);
  const rawAttemptTokens = attempt["tokens"] as Record<string, unknown> | undefined;
  const prompt = Math.floor(nonnegative(rawAttemptTokens?.["prompt"]));
  const completion = Math.floor(nonnegative(rawAttemptTokens?.["completion"]));
  const total = Math.floor(
    nonnegative(rawAttemptTokens?.["total"], prompt + completion),
  );

  telemetry.tokens.prompt += prompt;
  telemetry.tokens.completion += completion;
  telemetry.tokens.total += total;

  telemetry.estimated_tokens =
    telemetry.estimated_tokens || Boolean(attempt["estimated_tokens"]);
  telemetry.cost_usd =
    Math.round((telemetry.cost_usd + nonnegative(attempt["cost_usd"])) * 1e6) /
    1e6;

  telemetry.duration_seconds =
    Math.round(
      (telemetry.duration_seconds +
        nonnegative(attempt["duration_seconds"])) *
        1e3,
    ) / 1e3;
  telemetry.agent_duration_seconds =
    Math.round(
      (telemetry.agent_duration_seconds +
        nonnegative(attempt["agent_duration_seconds"])) *
        1e3,
    ) / 1e3;
  telemetry.verification_duration_seconds =
    Math.round(
      (telemetry.verification_duration_seconds +
        nonnegative(attempt["verification_duration_seconds"])) *
        1e3,
    ) / 1e3;

  const failure = attempt["failure"];
  if (
    typeof failure === "string" &&
    (FAILURE_MODES as readonly string[]).includes(failure)
  ) {
    const key = failure as FailureMode;
    telemetry.failure_modes[key] = (telemetry.failure_modes[key] ?? 0) + 1;
  }

  const attempts = (task["attempts"] as Array<Record<string, unknown>> | undefined) ?? [];
  attempts.push(attempt);
  task["attempts"] = attempts;
  task["telemetry"] = telemetry;

  const refreshed = computeTaskTelemetry(task, defaultCap);
  task["telemetry"] = refreshed;
  return refreshed;
}

export function computeActiveAttempt(
  task: Record<string, unknown>,
  now?: Date,
): {
  agent: string;
  phase: "agent" | "verification";
  started_at: string;
  elapsed_seconds: number;
} | null {
  const active = task["active_attempt"] as Record<string, unknown> | undefined;
  const status = task["status"];
  if (
    !active ||
    task["closed_at"] ||
    (status !== "in_progress" && status !== "ready_for_verification")
  ) {
    return null;
  }

  try {
    const rawStarted = active["started_at"];
    const startedAt = typeof rawStarted === "string" ? rawStarted : "";
    const start = new Date(startedAt);
    if (Number.isNaN(start.getTime())) return null;
    const current = now ?? new Date();
    const elapsed = Math.max(0, (current.getTime() - start.getTime()) / 1000);
    const rawAgent = active["agent"];
    const agent = typeof rawAgent === "string" ? rawAgent : "unknown";
    return {
      agent,
      phase: active["phase"] === "verification" ? "verification" : "agent",
      started_at: startedAt,
      elapsed_seconds: Math.round(elapsed * 1000) / 1000,
    };
  } catch {
    return null;
  }
}

export function computeBuildMetrics(
  tasks: Array<Record<string, unknown>>,
): BuildMetrics {
  let totalTokens = 0;
  let totalCost = 0.0;
  let totalDuration = 0.0;
  let attempts = 0;
  let retries = 0;
  const caps: Array<number | null> = [];
  let exceeded = false;
  const failures: FailureModes = {};
  const agents: Record<string, AgentMetrics> = {};

  for (const task of tasks) {
    const rawTelemetry = task["telemetry"] as TaskTelemetry | undefined;
    const telemetry = rawTelemetry ?? computeTaskTelemetry(task);
    totalTokens += telemetry.tokens.total;
    totalCost += telemetry.cost_usd;
    totalDuration += telemetry.duration_seconds;
    const count = telemetry.attempt_count;
    attempts += count;
    retries += Math.max(0, count - 1);
    const cap = telemetry.budget.cap_usd;
    caps.push(cap);
    exceeded = exceeded || telemetry.budget.exceeded;

    for (const key of FAILURE_MODES) {
      const modeCount = telemetry.failure_modes[key];
      if (typeof modeCount === "number" && modeCount > 0) {
        failures[key] = (failures[key] ?? 0) + modeCount;
      }
    }

    const taskAttempts = (task["attempts"] as Array<Record<string, unknown>> | undefined) ?? [];
    for (let index = 0; index < taskAttempts.length; index++) {
      const attempt = taskAttempts[index];
      if (!attempt) continue;
      const rawAgent = attempt["agent"];
      const agentName = typeof rawAgent === "string" ? rawAgent : "unknown";
      let row = agents[agentName];
      if (!row) {
        row = {
          agent: agentName,
          attempt_count: 0,
          failed_attempts: 0,
          total_tokens: 0,
          total_cost_usd: 0,
          avg_latency_seconds: 0,
          retry_rate: 0,
          failure_modes: {},
        };
        agents[agentName] = row;
      }
      row.attempt_count += 1;
      row.failed_attempts += attempt["failure"] ? 1 : 0;
      const attemptTokens = attempt["tokens"] as Record<string, unknown> | undefined;
      const tPrompt = nonnegative(attemptTokens?.["prompt"]);
      const tComp = nonnegative(attemptTokens?.["completion"]);
      const tTotal = nonnegative(attemptTokens?.["total"], tPrompt + tComp);
      row.total_tokens += Math.floor(tTotal);
      row.total_cost_usd += nonnegative(attempt["cost_usd"]);
      row.avg_latency_seconds += nonnegative(attempt["duration_seconds"]);
      row.retry_rate += index > 0 ? 1 : 0;

      const fMode = attempt["failure"];
      if (
        typeof fMode === "string" &&
        (FAILURE_MODES as readonly string[]).includes(fMode)
      ) {
        const k = fMode as FailureMode;
        row.failure_modes[k] = (row.failure_modes[k] ?? 0) + 1;
      }
    }
  }

  for (const row of Object.values(agents)) {
    row.total_cost_usd = Math.round(row.total_cost_usd * 1e6) / 1e6;
    row.avg_latency_seconds =
      row.attempt_count > 0
        ? Math.round((row.avg_latency_seconds / row.attempt_count) * 1e3) / 1e3
        : 0;
    row.retry_rate =
      row.attempt_count > 0
        ? Math.round((row.retry_rate / row.attempt_count) * 10_000) / 10_000
        : 0;
  }

  const sortedAgents = Object.values(agents).sort((a, b) =>
    a.agent.localeCompare(b.agent),
  );

  const allHaveCaps =
    caps.length > 0 && caps.every((c): c is number => c !== null);
  const totalCap = allHaveCaps
    ? caps.reduce<number>((acc, c) => acc + c, 0)
    : null;

  const budgetMetrics: BuildMetricsBudget = {
    total_cap_usd: totalCap,
    total_spent_usd: Math.round(totalCost * 1e6) / 1e6,
    exceeded,
  };

  const metrics: BuildMetrics = {
    total_tokens: totalTokens,
    total_cost_usd: Math.round(totalCost * 1e6) / 1e6,
    avg_latency_seconds:
      attempts > 0
        ? Math.round((totalDuration / attempts) * 1e3) / 1e3
        : 0,
    attempt_count: attempts,
    retry_rate:
      attempts > 0
        ? Math.round((retries / attempts) * 10_000) / 10_000
        : 0,
    failure_modes: failures,
    agents: sortedAgents,
    budget: budgetMetrics,
  };

  return BuildMetricsSchema.parse(metrics);
}

export function enforceBudget(
  task: TaskTelemetryInput,
  proposedCost = 0.0,
  defaultCap?: number | null,
): {
  allowed: boolean;
  cap_usd: number | null;
  spent_usd: number;
  projected_usd: number;
  exceeded: boolean;
  reason?: string;
} {
  const telemetry = computeTaskTelemetry(task, defaultCap);
  const cap = telemetry.budget.cap_usd;
  const spent = telemetry.budget.spent_usd;
  const projected =
    Math.round((spent + Math.max(0, nonnegative(proposedCost))) * 1e6) / 1e6;
  const exceeded = cap !== null && projected >= cap;
  const res: {
    allowed: boolean;
    cap_usd: number | null;
    spent_usd: number;
    projected_usd: number;
    exceeded: boolean;
    reason?: string;
  } = {
    allowed: !exceeded,
    cap_usd: cap,
    spent_usd: spent,
    projected_usd: projected,
    exceeded,
  };
  if (exceeded) {
    res.reason = "Budget limit exceeded";
  }
  return res;
}
