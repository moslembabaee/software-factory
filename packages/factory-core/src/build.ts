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
export type TaskTelemetry = z.infer<typeof TaskTelemetrySchema>;
export type AgentMetrics = z.infer<typeof AgentMetricsSchema>;
export type BuildMetrics = z.infer<typeof BuildMetricsSchema>;
export type BuildMetricsBudget = z.infer<typeof BuildMetricsBudgetSchema>;
export type BuildBudgetUpdate = z.infer<typeof BuildBudgetUpdateSchema>;

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
