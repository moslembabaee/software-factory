import { z } from "zod";

export const BuildStatusSchema = z.enum([
  "pending",
  "waiting_approval",
  "pending_approval",
  "approved",
  "in_progress",
  "completed",
  "failed",
  "cancelled",
]);
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
});
export const BuildLogSchema = z.strictObject({
  id: z.uuid(),
  task_id: z.string(),
  source: z.enum(["orchestrator", "webhook", "dashboard"]),
  timestamp: z.string(),
  message: z.string().max(4000),
});
export const BuildSnapshotSchema = z.strictObject({
  tasks: z.array(BuildTaskSchema),
  current_task_id: z.string().nullable(),
  logs: z.array(BuildLogSchema).max(200),
});
export const BuildApprovalSchema = z.strictObject({
  revision: z.string().regex(/^[a-f0-9]{64}$/),
});
export type BuildTask = z.infer<typeof BuildTaskSchema>;
export type BuildLog = z.infer<typeof BuildLogSchema>;
export type BuildSnapshot = z.infer<typeof BuildSnapshotSchema>;
export function canApproveTask(task: BuildTask): boolean {
  return (
    !task.closed_at &&
    ["pending", "waiting_approval", "pending_approval", "failed"].includes(
      task.status,
    )
  );
}
