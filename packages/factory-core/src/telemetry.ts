import {
  type TaskTokens,
  type TaskTelemetry,
  type BuildMetrics,
  type AgentMetrics,
} from "./build.js";

export interface AgentRate {
  prompt: number;
  completion: number;
}

export const DEFAULT_AGENT_RATES: Record<string, AgentRate> = {
  claude: { prompt: 3.0, completion: 15.0 },
  codex: { prompt: 2.5, completion: 10.0 },
  antigravity: { prompt: 0.15, completion: 0.6 },
};

export const KNOWN_FAILURE_MODES = [
  "quota",
  "agent",
  "verification",
  "budget_exceeded",
  "timeout",
  "runtime",
] as const;

export type KnownFailureMode = (typeof KNOWN_FAILURE_MODES)[number];

export interface AttemptTelemetryInput {
  agent: string;
  tokens: TaskTokens;
  estimated_tokens?: boolean;
  cost_usd: number;
  duration_seconds: number;
  agent_duration_seconds: number;
  verification_duration_seconds: number;
  failure?: string | null;
  exit_code?: number | null;
  log_tail?: string;
  timestamp?: string;
}

export interface TaskTelemetryInput {
  budget_cap_usd?: number | null;
  telemetry?: Partial<TaskTelemetry> | null;
  attempts?: AttemptTelemetryInput[];
  status?: string;
  closed_at?: string | null;
  active_attempt?: {
    agent: string;
    phase: "agent" | "verification";
    started_at: string;
    elapsed_seconds?: number;
  } | null;
}

export function toNonNegative(value: unknown, defaultValue = 0): number {
  if (
    typeof value === "number" &&
    Number.isFinite(value) &&
    !Number.isNaN(value) &&
    value >= 0
  ) {
    return value;
  }
  return defaultValue;
}

/**
 * Extracts prompt and completion token counts from an execution log tail,
 * falling back to character-based heuristic estimation when no structured metrics exist.
 */
export function extractTokenUsage(
  prompt: string,
  output: string,
): { tokens: TaskTokens; estimated: boolean } {
  // Decode complete JSON records and nested usage objects from output
  const candidates: Array<{ prompt: number; completion: number }> = [];

  let searchIndex = 0;
  while (searchIndex < output.length) {
    const openIndex = output.indexOf("{", searchIndex);
    if (openIndex === -1) break;

    // Attempt parsing balanced JSON object from this open brace
    let depth = 0;
    let inString = false;
    let escape = false;
    let endIndex = -1;

    for (let i = openIndex; i < output.length; i++) {
      const char = output[i];
      if (escape) {
        escape = false;
        continue;
      }
      if (char === "\\") {
        escape = true;
        continue;
      }
      if (char === '"') {
        inString = !inString;
        continue;
      }
      if (!inString) {
        if (char === "{") depth++;
        else if (char === "}") {
          depth--;
          if (depth === 0) {
            endIndex = i + 1;
            break;
          }
        }
      }
    }

    if (endIndex !== -1) {
      try {
        const jsonStr = output.slice(openIndex, endIndex);
        const parsed = JSON.parse(jsonStr) as Record<string, unknown>;

        // Look for top-level usage or nested usage
        const usageObj =
          parsed["usage"] && typeof parsed["usage"] === "object"
            ? (parsed["usage"] as Record<string, unknown>)
            : parsed;

        const p = usageObj["input_tokens"] ?? usageObj["prompt_tokens"];
        const c = usageObj["output_tokens"] ?? usageObj["completion_tokens"];

        if (
          typeof p === "number" &&
          p >= 0 &&
          typeof c === "number" &&
          c >= 0
        ) {
          candidates.push({ prompt: p, completion: c });
        }
      } catch {
        // ignore parse errors and advance
      }
      searchIndex = openIndex + 1;
    } else {
      searchIndex = openIndex + 1;
    }
  }

  if (candidates.length > 0) {
    const last = candidates[candidates.length - 1]!;
    return {
      tokens: {
        prompt: last.prompt,
        completion: last.completion,
        total: last.prompt + last.completion,
      },
      estimated: false,
    };
  }

  // Regex fallback: "tokens: 100 prompt, 20 completion"
  const regexPromptCompletion =
    /tokens?:\s*(\d+)\s*(?:prompt|input)[,\s]+(\d+)\s*(?:completion|output)/i;
  const matchPromptComp = regexPromptCompletion.exec(output);
  if (matchPromptComp) {
    const p = parseInt(matchPromptComp[1]!, 10);
    const c = parseInt(matchPromptComp[2]!, 10);
    return {
      tokens: { prompt: p, completion: c, total: p + c },
      estimated: false,
    };
  }

  // Regex fallback for total tokens: "total_tokens: 1,234"
  const regexTotal = /(?:total[_\s]tokens|tokens?\s+used)\s*:?\s*([\d,]+)/i;
  const matchTotal = regexTotal.exec(output);
  if (matchTotal) {
    const total = parseInt(matchTotal[1]!.replace(/,/g, ""), 10);
    const p = Math.min(total, Math.floor((prompt.length + 3) / 4));
    return {
      tokens: { prompt: p, completion: total - p, total },
      estimated: true,
    };
  }

  // Character estimate: 1 token ~ 4 chars
  const p = Math.floor((prompt.length + 3) / 4);
  const c = Math.floor((output.length + 3) / 4);
  return {
    tokens: { prompt: p, completion: c, total: p + c },
    estimated: true,
  };
}

/**
 * Calculates cost in USD for a given token usage and agent pricing rates.
 */
export function calculateTokenCost(
  agent: string,
  tokens: { prompt: number; completion: number },
  rates: Record<string, AgentRate> = DEFAULT_AGENT_RATES,
): number {
  const rate = rates[agent] ?? rates["claude"] ?? { prompt: 3.0, completion: 15.0 };
  const rawCost =
    (tokens.prompt * rate.prompt + tokens.completion * rate.completion) /
    1_000_000;
  return Number(rawCost.toFixed(6));
}

/**
 * Validates and retrieves the budget cap for a task.
 */
export function calculateBudgetCap(
  task: { budget_cap_usd?: number | null },
  defaultCap?: number | null,
): number | null {
  const value = task.budget_cap_usd !== undefined ? task.budget_cap_usd : defaultCap;
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new ValueError("budget_cap_usd must be finite and nonnegative");
  }
  return value;
}

export class ValueError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValueError";
  }
}

/**
 * Computes consolidated telemetry for a task including historical attempt spend.
 */
export function computeTaskTelemetry(
  task: TaskTelemetryInput,
  defaultCap?: number | null,
): TaskTelemetry {
  const raw = task.telemetry ?? {};
  const attempts = task.attempts ?? [];
  const count = attempts.length;

  const rawTokens = raw.tokens ?? { prompt: 0, completion: 0, total: 0 };
  const prompt = Math.floor(toNonNegative(rawTokens.prompt));
  const completion = Math.floor(toNonNegative(rawTokens.completion));
  const spent = toNonNegative(raw.cost_usd);

  const inheritedCap =
    defaultCap !== undefined ? defaultCap : raw.budget?.cap_usd ?? null;
  const cap = calculateBudgetCap(task, inheritedCap);

  const rawFailures = raw.failure_modes ?? {};
  const failures: Record<string, number> = {};
  for (const mode of KNOWN_FAILURE_MODES) {
    if (mode in rawFailures && typeof rawFailures[mode] === "number") {
      failures[mode] = Math.floor(toNonNegative(rawFailures[mode]));
    }
  }

  const failedAttempts = attempts.filter((att) => Boolean(att.failure)).length;
  const retryRate = count > 0 ? Number((Math.max(0, count - 1) / count).toFixed(4)) : 0;

  return {
    tokens: {
      prompt,
      completion,
      total: prompt + completion,
    },
    estimated_tokens: Boolean(raw.estimated_tokens),
    cost_usd: spent,
    duration_seconds: toNonNegative(raw.duration_seconds),
    agent_duration_seconds: toNonNegative(raw.agent_duration_seconds),
    verification_duration_seconds: toNonNegative(
      raw.verification_duration_seconds,
    ),
    attempt_count: count,
    failed_attempts: failedAttempts,
    retry_rate: retryRate,
    failure_modes: failures,
    budget: {
      cap_usd: cap,
      spent_usd: spent,
      exceeded: cap !== null && spent >= cap,
    },
  };
}

/**
 * Appends an attempt execution record to a task and updates its aggregated telemetry.
 */
export function recordAttemptTelemetry(
  task: TaskTelemetryInput,
  attempt: AttemptTelemetryInput,
  defaultCap?: number | null,
): TaskTelemetry {
  const telemetry = computeTaskTelemetry(task, defaultCap);

  telemetry.tokens.prompt += attempt.tokens.prompt;
  telemetry.tokens.completion += attempt.tokens.completion;
  telemetry.tokens.total =
    telemetry.tokens.prompt + telemetry.tokens.completion;

  telemetry.estimated_tokens =
    telemetry.estimated_tokens || Boolean(attempt.estimated_tokens);
  telemetry.cost_usd = Number(
    (telemetry.cost_usd + attempt.cost_usd).toFixed(6),
  );
  telemetry.duration_seconds = Number(
    (telemetry.duration_seconds + attempt.duration_seconds).toFixed(3),
  );
  telemetry.agent_duration_seconds = Number(
    (
      telemetry.agent_duration_seconds + attempt.agent_duration_seconds
    ).toFixed(3),
  );
  telemetry.verification_duration_seconds = Number(
    (
      telemetry.verification_duration_seconds +
      attempt.verification_duration_seconds
    ).toFixed(3),
  );

  if (
    attempt.failure &&
    (KNOWN_FAILURE_MODES as readonly string[]).includes(attempt.failure)
  ) {
    const failureKey = attempt.failure as keyof typeof telemetry.failure_modes;
    telemetry.failure_modes[failureKey] =
      ((telemetry.failure_modes[failureKey] as number | undefined) ?? 0) + 1;
  }

  if (!task.attempts) {
    task.attempts = [];
  }
  task.attempts.push(attempt);
  task.telemetry = telemetry;

  // Re-sync with task budget
  const finalTelemetry = computeTaskTelemetry(task, defaultCap);
  task.telemetry = finalTelemetry;
  return finalTelemetry;
}

/**
 * Computes active attempt metrics with elapsed runtime in seconds.
 */
export function computeActiveAttempt(
  task: {
    active_attempt?: {
      agent: string;
      phase: "agent" | "verification";
      started_at: string;
    } | null;
    closed_at?: string | null;
    status: string;
  },
  now: Date = new Date(),
): {
  agent: string;
  phase: "agent" | "verification";
  started_at: string;
  elapsed_seconds: number;
} | null {
  const active = task.active_attempt;
  if (
    !active ||
    task.closed_at ||
    (task.status !== "in_progress" && task.status !== "ready_for_verification")
  ) {
    return null;
  }

  try {
    const started = new Date(active.started_at);
    if (Number.isNaN(started.getTime())) return null;
    const elapsed = Math.max(0, (now.getTime() - started.getTime()) / 1000);
    return {
      agent: active.agent,
      phase: active.phase,
      started_at: active.started_at,
      elapsed_seconds: Number(elapsed.toFixed(3)),
    };
  } catch {
    return null;
  }
}

/**
 * Aggregates operational overhead metrics across all tenant tasks.
 */
export function aggregateBuildMetrics(
  tasks: Array<{
    telemetry: TaskTelemetry;
    attempts?: AttemptTelemetryInput[];
  }>,
): BuildMetrics {
  let totalTokens = 0;
  let totalCost = 0;
  let totalDuration = 0;
  let attempts = 0;
  let retries = 0;
  const caps: Array<number | null> = [];
  let exceeded = false;
  const failures: Record<string, number> = {};
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
      failure_modes: Record<string, number>;
    }
  >();

  for (const task of tasks) {
    const tel = task.telemetry;
    totalTokens += tel.tokens.total;
    totalCost += tel.cost_usd;
    totalDuration += tel.duration_seconds;
    const count = tel.attempt_count;
    attempts += count;
    retries += Math.max(0, count - 1);

    const cap = tel.budget.cap_usd;
    caps.push(cap);
    exceeded = exceeded || tel.budget.exceeded;

    for (const [mode, cnt] of Object.entries(tel.failure_modes)) {
      if (cnt && typeof cnt === "number") {
        failures[mode] = (failures[mode] ?? 0) + cnt;
      }
    }

    const taskAttempts = task.attempts ?? [];
    for (let index = 0; index < taskAttempts.length; index++) {
      const att = taskAttempts[index]!;
      const agent = att.agent;
      let row = agentMap.get(agent);
      if (!row) {
        row = {
          agent,
          attempt_count: 0,
          failed_attempts: 0,
          total_tokens: 0,
          total_cost_usd: 0,
          avg_latency_seconds: 0,
          retry_rate: 0,
          failure_modes: {},
        };
        agentMap.set(agent, row);
      }

      row.attempt_count += 1;
      row.failed_attempts += att.failure ? 1 : 0;
      row.total_tokens += toNonNegative(att.tokens?.total);
      row.total_cost_usd += toNonNegative(att.cost_usd);
      row.avg_latency_seconds += toNonNegative(att.duration_seconds);
      row.retry_rate += index > 0 ? 1 : 0;

      const failure = att.failure;
      if (failure && (KNOWN_FAILURE_MODES as readonly string[]).includes(failure)) {
        row.failure_modes[failure] = (row.failure_modes[failure] ?? 0) + 1;
      }
    }
  }

  const agents: AgentMetrics[] = Array.from(agentMap.values()).map((row) => ({
    agent: row.agent,
    attempt_count: row.attempt_count,
    failed_attempts: row.failed_attempts,
    total_tokens: row.total_tokens,
    total_cost_usd: Number(row.total_cost_usd.toFixed(6)),
    avg_latency_seconds: Number(
      (row.avg_latency_seconds / row.attempt_count).toFixed(3),
    ),
    retry_rate: Number((row.retry_rate / row.attempt_count).toFixed(4)),
    failure_modes: row.failure_modes,
  }));

  agents.sort((a, b) => a.agent.localeCompare(b.agent));

  const allCapsDefined = caps.length > 0 && caps.every((c) => c !== null);
  const totalCapUsd = allCapsDefined
    ? caps.reduce<number>((acc, cur) => acc + (cur ?? 0), 0)
    : null;

  return {
    total_tokens: totalTokens,
    total_cost_usd: Number(totalCost.toFixed(6)),
    avg_latency_seconds:
      attempts > 0 ? Number((totalDuration / attempts).toFixed(3)) : 0,
    attempt_count: attempts,
    retry_rate: attempts > 0 ? Number((retries / attempts).toFixed(4)) : 0,
    failure_modes: failures,
    agents,
    budget: {
      total_cap_usd: totalCapUsd,
      total_spent_usd: Number(totalCost.toFixed(6)),
      exceeded,
    },
  };
}
