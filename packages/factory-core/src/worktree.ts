import { z } from "zod";

export const WorktreeStatusSchema = z.enum([
  "active",
  "cleaning",
  "cleaned",
  "reconciled",
  "conflicted",
  "failed",
]);

export const WorktreeInfoSchema = z.strictObject({
  taskId: z.string().min(1),
  worktreePath: z.string().min(1),
  branch: z.string().min(1),
  baseBranch: z.string().min(1),
  createdAt: z.string(),
  status: WorktreeStatusSchema,
  reconciledAt: z.string().nullable().optional(),
  cleanedAt: z.string().nullable().optional(),
  commitSha: z.string().nullable().optional(),
  error: z.string().nullable().optional(),
});

export const WorktreeConflictDetailsSchema = z.strictObject({
  hasConflict: z.boolean(),
  conflictingFiles: z.array(z.string()),
  baseBranch: z.string().min(1),
  branch: z.string().min(1),
  baseSha: z.string().optional(),
  headSha: z.string().optional(),
  error: z.string().optional(),
});

export const WorktreeReconciliationResultSchema = z.strictObject({
  success: z.boolean(),
  reconciledSha: z.string().optional(),
  baseBranch: z.string().min(1),
  branch: z.string().min(1),
  hasConflict: z.boolean().default(false),
  conflictingFiles: z.array(z.string()).default([]),
  reverified: z.boolean().default(false),
  verificationPassed: z.boolean().optional(),
  error: z.string().optional(),
});

export const ConcurrentExecutionConfigSchema = z.strictObject({
  maxConcurrentTasks: z.number().int().positive().default(1),
  worktreeRootDir: z.string().optional(),
  baseBranch: z.string().default("main"),
  cleanupOnExit: z.boolean().default(true),
  reconcileOnSuccess: z.boolean().default(true),
  verificationTimeout: z.number().positive().default(300),
});

export const ConcurrentExecutionStatusSchema = z.strictObject({
  activeTasks: z.array(WorktreeInfoSchema),
  completedTasks: z.array(z.string()),
  failedTasks: z.array(z.string()),
  conflictedTasks: z.array(z.string()),
  availableSlots: z.number().int().nonnegative(),
});

export type WorktreeStatus = z.infer<typeof WorktreeStatusSchema>;
export type WorktreeInfo = z.infer<typeof WorktreeInfoSchema>;
export type WorktreeConflictDetails = z.infer<typeof WorktreeConflictDetailsSchema>;
export type WorktreeReconciliationResult = z.infer<typeof WorktreeReconciliationResultSchema>;
export type ConcurrentExecutionConfig = z.infer<typeof ConcurrentExecutionConfigSchema>;
export type ConcurrentExecutionStatus = z.infer<typeof ConcurrentExecutionStatusSchema>;

/**
 * Generates an isolated worktree path for a given task ID.
 */
export function generateWorktreePath(
  rootDir: string,
  taskId: string,
  worktreesSubdir = ".worktrees",
): string {
  const sanitizedTaskId = taskId.toLowerCase().replace(/[^a-z0-9_-]/g, "-");
  const normalizedRoot = rootDir.replace(/\/+$/, "");
  return `${normalizedRoot}/${worktreesSubdir}/${sanitizedTaskId}`;
}

/**
 * Generates a standard git branch name for a task worktree.
 */
export function generateWorktreeBranch(
  taskId: string,
  prefix = "factory",
): string {
  const sanitized = taskId.toLowerCase().replace(/[^a-z0-9_-]/g, "-");
  return `${prefix}/${sanitized}`;
}

/**
 * Parses conflicting file paths from git command output (e.g. merge-tree, status, rebase).
 */
export function parseWorktreeConflictFiles(output: string): string[] {
  const files = new Set<string>();

  const mergeConflictRegex = /CONFLICT\s+\([^)]+\):\s+Merge conflict in\s+(\S+)/g;
  let match: RegExpExecArray | null;
  while ((match = mergeConflictRegex.exec(output)) !== null) {
    if (match[1]) files.add(match[1].replace(/['"]/g, "").trim());
  }

  const conflictActionRegex = /CONFLICT\s+\([^)]+\):\s+(\S+)\s+(?:deleted|modified|was)/g;
  while ((match = conflictActionRegex.exec(output)) !== null) {
    if (match[1]) files.add(match[1].replace(/['"]/g, "").trim());
  }

  const porcelainRegex = /^(?:UU|AA|UD|DU|UA|AU)\s+(.+)$/gm;
  while ((match = porcelainRegex.exec(output)) !== null) {
    if (match[1]) files.add(match[1].trim());
  }

  const rawTreeRegex = /^\d+\s+[0-9a-f]{40}\s+[123]\t(.+)$/gm;
  while ((match = rawTreeRegex.exec(output)) !== null) {
    if (match[1]) files.add(match[1].trim());
  }

  return Array.from(files).sort();
}

/**
 * Detects overlapping modified files between two task sets.
 */
export function detectFileOverlap(filesA: string[], filesB: string[]): string[] {
  const setA = new Set(filesA);
  return filesB.filter((f) => setA.has(f)).sort();
}

/**
 * Evaluates whether two tasks can safely run concurrently without conflict risks.
 */
export function canExecuteConcurrently(
  taskA: { files?: string[] },
  taskB: { files?: string[] },
): boolean {
  if (!taskA.files || !taskB.files) {
    return true;
  }
  return detectFileOverlap(taskA.files, taskB.files).length === 0;
}

/**
 * Evaluates reconciliation status and determines the next worktree state.
 */
export function evaluateReconciliationOutcome(result: {
  hasConflict: boolean;
  reverified?: boolean;
  verificationPassed?: boolean;
  error?: string;
}): { success: boolean; status: WorktreeStatus; error?: string } {
  if (result.hasConflict) {
    return {
      success: false,
      status: "conflicted",
      error: result.error ?? "Merge conflict detected during baseline reconciliation",
    };
  }

  if (result.reverified && result.verificationPassed === false) {
    return {
      success: false,
      status: "failed",
      error: result.error ?? "Re-verification failed after baseline rebase",
    };
  }

  return {
    success: true,
    status: "reconciled",
  };
}

/**
 * Formats a log record for workspace cleanup.
 */
export function formatWorktreeCleanupLog(
  taskId: string,
  worktreePath: string,
  success: boolean,
): string {
  const status = success ? "cleanly removed" : "failed to remove";
  return `Workspace cleanup for ${taskId}: worktree at ${worktreePath} ${status}`;
}
