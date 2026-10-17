import { z } from "zod";

export const WorktreeStatusSchema = z.enum([
  "active",
  "verified",
  "failed",
  "cleaned",
  "conflicted",
]);

export const WorktreeConfigSchema = z.strictObject({
  projectRoot: z.string().min(1),
  worktreeDir: z.string().min(1),
  baseBranch: z.string().default("main"),
  branchPrefix: z.string().default("factory"),
  timeout: z.number().positive().default(60),
});

export const WorktreeInfoSchema = z.strictObject({
  taskId: z.string().min(1),
  path: z.string().min(1),
  branch: z.string().min(1),
  baseBranch: z.string().default("main"),
  createdAt: z.string(),
  headSha: z.string().default(""),
  status: WorktreeStatusSchema.default("active"),
});

export const ConflictDetectionResultSchema = z.strictObject({
  hasConflict: z.boolean(),
  conflictingFiles: z.array(z.string()).default([]),
  baseBranch: z.string().default("main"),
  taskBranch: z.string(),
  overlappingTasks: z.array(z.string()).default([]),
  error: z.string().optional().nullable(),
});

export const MergeReconciliationResultSchema = z.strictObject({
  success: z.boolean(),
  taskId: z.string().min(1),
  mergedSha: z.string().default(""),
  baseBranch: z.string().default("main"),
  taskBranch: z.string(),
  conflictDetected: z.boolean().default(false),
  conflictingFiles: z.array(z.string()).default([]),
  error: z.string().optional().nullable(),
  cleanedUp: z.boolean().default(false),
  timestamp: z.string(),
});

export const WorktreeCleanupResultSchema = z.strictObject({
  success: z.boolean(),
  taskId: z.string().min(1),
  path: z.string().min(1),
  branchDeleted: z.boolean().default(false),
  error: z.string().optional().nullable(),
});

export const ParallelExecutionTaskStatusSchema = z.enum([
  "pending",
  "running",
  "verified",
  "reconciled",
  "failed",
  "conflicted",
]);

export const ParallelExecutionTaskSchema = z.strictObject({
  taskId: z.string().min(1),
  branch: z.string().min(1),
  worktreePath: z.string().min(1),
  status: ParallelExecutionTaskStatusSchema.default("pending"),
  error: z.string().optional().nullable(),
});

export const OverlapConflictDetailSchema = z.strictObject({
  overlappingTasks: z.array(z.string()),
  files: z.array(z.string()),
});

export const ParallelExecutionPlanSchema = z.strictObject({
  tasks: z.array(ParallelExecutionTaskSchema),
  maxConcurrency: z.number().int().positive(),
  overlappingConflicts: z.record(z.string(), OverlapConflictDetailSchema),
});

export type WorktreeStatus = z.infer<typeof WorktreeStatusSchema>;
export type WorktreeConfig = z.infer<typeof WorktreeConfigSchema>;
export type WorktreeInfo = z.infer<typeof WorktreeInfoSchema>;
export type ConflictDetectionResult = z.infer<typeof ConflictDetectionResultSchema>;
export type MergeReconciliationResult = z.infer<typeof MergeReconciliationResultSchema>;
export type WorktreeCleanupResult = z.infer<typeof WorktreeCleanupResultSchema>;
export type ParallelExecutionTaskStatus = z.infer<typeof ParallelExecutionTaskStatusSchema>;
export type ParallelExecutionTask = z.infer<typeof ParallelExecutionTaskSchema>;
export type OverlapConflictDetail = z.infer<typeof OverlapConflictDetailSchema>;
export type ParallelExecutionPlan = z.infer<typeof ParallelExecutionPlanSchema>;

export function sanitizeTaskBranchName(taskId: string, prefix = "factory"): string {
  const sanitized = taskId.replace(/[^a-zA-Z0-9-]+/g, "-").replace(/^-+|-+$/g, "").toLowerCase().slice(0, 120);
  return `${prefix}/${sanitized}`;
}

export function parseGitWorktreeList(porcelainOutput: string): WorktreeInfo[] {
  const worktrees: WorktreeInfo[] = [];
  const entries = porcelainOutput.split(/\n\n+/);

  for (const entry of entries) {
    if (!entry.trim()) continue;
    let path = "";
    let headSha = "";
    let branch = "";

    const lines = entry.split(/\r?\n/);
    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (line.startsWith("worktree ")) {
        path = line.slice("worktree ".length).trim();
      } else if (line.startsWith("HEAD ")) {
        headSha = line.slice("HEAD ".length).trim();
      } else if (line.startsWith("branch ")) {
        const fullRef = line.slice("branch ".length).trim();
        branch = fullRef.replace(/^refs\/heads\//, "");
      }
    }

    if (path) {
      // Derive task ID from path or branch if possible
      const pathSegments = path.replace(/[\\/]+$/, "").split(/[\\/]/);
      const lastSegment = pathSegments[pathSegments.length - 1] ?? "";
      const taskId = lastSegment.replace(/^worktree-|^task-/, "") || branch.replace(/^factory\//, "") || "unknown";

      worktrees.push({
        taskId,
        path,
        branch: branch || "detached",
        baseBranch: "main",
        createdAt: new Date().toISOString(),
        headSha,
        status: "active",
      });
    }
  }

  return worktrees;
}

export function detectOverlappingFiles(
  taskFileChanges: Record<string, string[]>,
): Record<string, OverlapConflictDetail> {
  const taskIds = Object.keys(taskFileChanges);
  const result: Record<string, OverlapConflictDetail> = {};

  for (let i = 0; i < taskIds.length; i++) {
    const tA = taskIds[i]!;
    const filesA = new Set(taskFileChanges[tA] ?? []);
    const overlaps: string[] = [];
    const sharedFiles = new Set<string>();

    for (let j = 0; j < taskIds.length; j++) {
      if (i === j) continue;
      const tB = taskIds[j]!;
      const filesB = taskFileChanges[tB] ?? [];
      let hasOverlap = false;

      for (const f of filesB) {
        if (filesA.has(f)) {
          sharedFiles.add(f);
          hasOverlap = true;
        }
      }

      if (hasOverlap) {
        overlaps.push(tB);
      }
    }

    if (overlaps.length > 0) {
      result[tA] = {
        overlappingTasks: overlaps,
        files: Array.from(sharedFiles).sort(),
      };
    }
  }

  return result;
}

export function planParallelWorktreeExecution(
  tasks: Array<{ id: string; branch?: string }>,
  worktreeRootDir: string,
  maxConcurrency = 2,
  fileChanges: Record<string, string[]> = {},
): ParallelExecutionPlan {
  const safeConcurrency = Math.max(1, maxConcurrency);
  const executionTasks: ParallelExecutionTask[] = tasks.map((t) => {
    const branch = t.branch ?? sanitizeTaskBranchName(t.id);
    const sanitizedId = t.id.replace(/[^a-zA-Z0-9-]+/g, "-").toLowerCase();
    const worktreePath = `${worktreeRootDir}/task-${sanitizedId}`;

    return {
      taskId: t.id,
      branch,
      worktreePath,
      status: "pending",
      error: null,
    };
  });

  const overlappingConflicts = detectOverlappingFiles(fileChanges);

  return {
    tasks: executionTasks,
    maxConcurrency: safeConcurrency,
    overlappingConflicts,
  };
}

export function evaluateMergeReconciliation(
  conflictResult: ConflictDetectionResult,
  isVerified: boolean,
): { canMerge: boolean; reason: string } {
  if (!isVerified) {
    return {
      canMerge: false,
      reason: "Task verification must succeed before baseline merge reconciliation",
    };
  }

  if (conflictResult.hasConflict) {
    const fileCount = conflictResult.conflictingFiles.length;
    const fileList = conflictResult.conflictingFiles.slice(0, 3).join(", ");
    return {
      canMerge: false,
      reason: `Automated conflict detection failed: ${fileCount} conflicting file(s) [${fileList}]`,
    };
  }

  return {
    canMerge: true,
    reason: "No conflicts detected; verified worktree task ready for baseline merge reconciliation",
  };
}
