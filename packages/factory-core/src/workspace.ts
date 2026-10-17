import { z } from "zod";

export const WorkspaceFileStatusSchema = z.enum([
  "modified",
  "added",
  "deleted",
  "untracked",
  "renamed",
  "copied",
  "conflict",
]);

export const WorkspaceFileChangeSchema = z.strictObject({
  path: z.string().min(1),
  status: WorkspaceFileStatusSchema,
  staged: z.boolean(),
  origPath: z.string().optional().nullable(),
});

export const WorkspaceCleanlinessSchema = z.strictObject({
  clean: z.boolean(),
  changes: z.array(WorkspaceFileChangeSchema),
  modifiedFiles: z.array(z.string()),
  untrackedFiles: z.array(z.string()),
  stagedFiles: z.array(z.string()),
  deletedFiles: z.array(z.string()),
  conflictFiles: z.array(z.string()),
  hasIndexLock: z.boolean().default(false),
  branch: z.string().default("main"),
  headSha: z.string().default(""),
  summary: z.string(),
});

export const WorkspaceCheckpointSchema = z.strictObject({
  id: z.string().min(1),
  timestamp: z.string(),
  taskId: z.string().optional().nullable(),
  commitSha: z.string().min(1),
  branch: z.string().min(1),
  roadmapSnapshot: z.string().optional().nullable(),
  cleanliness: WorkspaceCleanlinessSchema.optional().nullable(),
});

export const RollbackStrategySchema = z.enum([
  "hard_reset",
  "clean_untracked",
  "restore_checkpoint",
  "reconcile_only",
]);

export const RollbackReasonSchema = z.enum([
  "unrecoverable_task_error",
  "verification_failure_limit",
  "dirty_workspace_drift",
  "corrupted_roadmap",
  "manual_recovery",
  "stale_task_timeout",
]);

export const RollbackPlanSchema = z.strictObject({
  strategy: RollbackStrategySchema,
  reason: RollbackReasonSchema,
  targetSha: z.string().min(1),
  targetBranch: z.string().min(1),
  removeLockFiles: z.boolean(),
  resetHard: z.boolean(),
  cleanUntracked: z.boolean(),
  restoreRoadmap: z.boolean(),
  checkpointId: z.string().optional().nullable(),
});

export const RollbackResultSchema = z.strictObject({
  success: z.boolean(),
  strategy: RollbackStrategySchema,
  reason: RollbackReasonSchema,
  previousHead: z.string(),
  restoredHead: z.string(),
  cleanedFiles: z.array(z.string()),
  restoredFiles: z.array(z.string()),
  roadmapRestored: z.boolean(),
  timestamp: z.string(),
  error: z.string().optional().nullable(),
});

export const DriftTypeSchema = z.enum([
  "corrupted_json",
  "missing_tasks_array",
  "orphaned_current_task",
  "inconsistent_task_status",
  "stale_in_progress",
  "git_head_mismatch",
]);

export const InconsistentTaskSchema = z.strictObject({
  taskId: z.string(),
  actualStatus: z.string(),
  expectedStatus: z.string(),
  reason: z.string(),
});

export const RoadmapDriftSchema = z.strictObject({
  hasDrift: z.boolean(),
  corrupted: z.boolean(),
  driftTypes: z.array(DriftTypeSchema),
  currentTaskId: z.string().optional().nullable(),
  orphanedTaskIds: z.array(z.string()),
  inconsistentTasks: z.array(InconsistentTaskSchema),
  details: z.string(),
});

export const ReconciliationActionTypeSchema = z.enum([
  "restore_roadmap_backup",
  "clear_current_task",
  "reset_task_status",
  "quarantine_untracked",
  "clean_workspace",
  "noop",
]);

export const ReconciliationActionSchema = z.strictObject({
  action: ReconciliationActionTypeSchema,
  taskId: z.string().optional().nullable(),
  details: z.string(),
});

export const ReconciliationResultSchema = z.strictObject({
  reconciled: z.boolean(),
  actionsApplied: z.array(ReconciliationActionSchema),
  restoredRoadmap: z.boolean(),
  previousCurrentTaskId: z.string().optional().nullable(),
  newCurrentTaskId: z.string().optional().nullable(),
  summary: z.string(),
});

export type WorkspaceFileStatus = z.infer<typeof WorkspaceFileStatusSchema>;
export type WorkspaceFileChange = z.infer<typeof WorkspaceFileChangeSchema>;
export type WorkspaceCleanliness = z.infer<typeof WorkspaceCleanlinessSchema>;
export type WorkspaceCheckpoint = z.infer<typeof WorkspaceCheckpointSchema>;
export type RollbackStrategy = z.infer<typeof RollbackStrategySchema>;
export type RollbackReason = z.infer<typeof RollbackReasonSchema>;
export type RollbackPlan = z.infer<typeof RollbackPlanSchema>;
export type RollbackResult = z.infer<typeof RollbackResultSchema>;
export type DriftType = z.infer<typeof DriftTypeSchema>;
export type InconsistentTask = z.infer<typeof InconsistentTaskSchema>;
export type RoadmapDrift = z.infer<typeof RoadmapDriftSchema>;
export type ReconciliationActionType = z.infer<typeof ReconciliationActionTypeSchema>;
export type ReconciliationAction = z.infer<typeof ReconciliationActionSchema>;
export type ReconciliationResult = z.infer<typeof ReconciliationResultSchema>;

export function parseGitStatusPorcelain(
  porcelainOutput: string,
  branch: string = "main",
  headSha: string = "",
  hasIndexLock: boolean = false,
): WorkspaceCleanliness {
  const changes: WorkspaceFileChange[] = [];
  const modifiedFiles: string[] = [];
  const untrackedFiles: string[] = [];
  const stagedFiles: string[] = [];
  const deletedFiles: string[] = [];
  const conflictFiles: string[] = [];

  const lines = porcelainOutput.split(/\r?\n/);
  for (const rawLine of lines) {
    if (!rawLine || !rawLine.trim()) continue;
    const line = rawLine;
    const x = line[0] ?? " ";
    const y = line[1] ?? " ";
    const pathPart = line.slice(3).trim();
    if (!pathPart) continue;

    let path = pathPart;
    let origPath: string | null = null;
    if (pathPart.includes(" -> ")) {
      const parts = pathPart.split(" -> ");
      origPath = parts[0] ?? null;
      path = parts[1] ?? pathPart;
    }

    // Unmerged / conflict states
    if (
      (x === "U" || y === "U") ||
      (x === "A" && y === "A") ||
      (x === "D" && y === "D")
    ) {
      changes.push({ path, status: "conflict", staged: false, origPath });
      conflictFiles.push(path);
      continue;
    }

    // Untracked
    if (x === "?" && y === "?") {
      changes.push({ path, status: "untracked", staged: false });
      untrackedFiles.push(path);
      continue;
    }

    // Staged changes
    if (x !== " " && x !== "?") {
      const status: WorkspaceFileStatus =
        x === "A" ? "added" : x === "D" ? "deleted" : x === "R" ? "renamed" : x === "C" ? "copied" : "modified";
      changes.push({ path, status, staged: true, origPath });
      stagedFiles.push(path);
      if (status === "deleted") deletedFiles.push(path);
      else if (status === "modified") modifiedFiles.push(path);
    }

    // Unstaged changes in working tree
    if (y !== " " && y !== "?") {
      const status: WorkspaceFileStatus = y === "D" ? "deleted" : "modified";
      changes.push({ path, status, staged: false, origPath });
      if (status === "deleted") {
        if (!deletedFiles.includes(path)) deletedFiles.push(path);
      } else {
        if (!modifiedFiles.includes(path)) modifiedFiles.push(path);
      }
    }
  }

  const isClean =
    changes.length === 0 &&
    !hasIndexLock;

  let summary = "Workspace is clean";
  if (!isClean) {
    const parts: string[] = [];
    if (modifiedFiles.length > 0) parts.push(`${modifiedFiles.length} modified`);
    if (untrackedFiles.length > 0) parts.push(`${untrackedFiles.length} untracked`);
    if (stagedFiles.length > 0) parts.push(`${stagedFiles.length} staged`);
    if (deletedFiles.length > 0) parts.push(`${deletedFiles.length} deleted`);
    if (conflictFiles.length > 0) parts.push(`${conflictFiles.length} in conflict`);
    if (hasIndexLock) parts.push("index.lock present");
    summary = `Workspace dirty: ${parts.join(", ")}`;
  }

  return {
    clean: isClean,
    changes,
    modifiedFiles,
    untrackedFiles,
    stagedFiles,
    deletedFiles,
    conflictFiles,
    hasIndexLock,
    branch,
    headSha,
    summary,
  };
}

export function validateWorkspaceCleanliness(status: WorkspaceCleanliness): {
  isValid: boolean;
  violations: string[];
  recommendedAction: "none" | "rollback" | "clean" | "unlock";
} {
  const violations: string[] = [];

  if (status.hasIndexLock) {
    violations.push("Git index is locked (.git/index.lock exists)");
  }
  if (status.conflictFiles.length > 0) {
    violations.push(`Unresolved merge conflicts detected in ${status.conflictFiles.length} file(s)`);
  }
  if (status.modifiedFiles.length > 0) {
    violations.push(`Uncommitted modifications detected in ${status.modifiedFiles.length} tracked file(s)`);
  }
  if (status.stagedFiles.length > 0) {
    violations.push(`Staged uncommitted changes detected in ${status.stagedFiles.length} file(s)`);
  }
  if (status.untrackedFiles.length > 0) {
    violations.push(`Untracked files detected in workspace: ${status.untrackedFiles.slice(0, 5).join(", ")}`);
  }

  let recommendedAction: "none" | "rollback" | "clean" | "unlock" = "none";
  if (status.hasIndexLock && status.changes.length === 0) {
    recommendedAction = "unlock";
  } else if (status.conflictFiles.length > 0 || status.modifiedFiles.length > 0) {
    recommendedAction = "rollback";
  } else if (status.untrackedFiles.length > 0) {
    recommendedAction = "clean";
  }

  return {
    isValid: violations.length === 0,
    violations,
    recommendedAction,
  };
}

export function createWorkspaceCheckpoint(options: {
  taskId?: string | null;
  commitSha: string;
  branch: string;
  roadmapSnapshot?: string | null;
  cleanliness?: WorkspaceCleanliness | null;
}): WorkspaceCheckpoint {
  const id = `chk-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  return {
    id,
    timestamp: new Date().toISOString(),
    taskId: options.taskId ?? null,
    commitSha: options.commitSha,
    branch: options.branch,
    roadmapSnapshot: options.roadmapSnapshot ?? null,
    cleanliness: options.cleanliness ?? null,
  };
}

export function planRollback(
  cleanliness: WorkspaceCleanliness,
  checkpoint: WorkspaceCheckpoint,
  reason: RollbackReason,
): RollbackPlan {
  const removeLockFiles = cleanliness.hasIndexLock;
  const resetHard = true;
  const cleanUntracked = cleanliness.untrackedFiles.length > 0;
  const restoreRoadmap = Boolean(checkpoint.roadmapSnapshot);

  let strategy: RollbackStrategy = "hard_reset";
  if (restoreRoadmap) {
    strategy = "restore_checkpoint";
  } else if (cleanUntracked && cleanliness.modifiedFiles.length === 0 && !cleanliness.hasIndexLock) {
    strategy = "clean_untracked";
  }

  return {
    strategy,
    reason,
    targetSha: checkpoint.commitSha,
    targetBranch: checkpoint.branch,
    removeLockFiles,
    resetHard,
    cleanUntracked,
    restoreRoadmap,
    checkpointId: checkpoint.id,
  };
}

export function detectRoadmapDrift(
  roadmapData: unknown,
  options: {
    currentCommitSha?: string;
    activeTaskIds?: string[];
    maxRetries?: number;
  } = {},
): RoadmapDrift {
  const driftTypes: DriftType[] = [];
  const orphanedTaskIds: string[] = [];
  const inconsistentTasks: InconsistentTask[] = [];

  if (!roadmapData || typeof roadmapData !== "object") {
    return {
      hasDrift: true,
      corrupted: true,
      driftTypes: ["corrupted_json"],
      currentTaskId: null,
      orphanedTaskIds: [],
      inconsistentTasks: [],
      details: "Roadmap data is not a valid JSON object",
    };
  }

  const raw = roadmapData as Record<string, unknown>;
  const rawTasks = raw["tasks"];
  if (!Array.isArray(rawTasks)) {
    return {
      hasDrift: true,
      corrupted: true,
      driftTypes: ["missing_tasks_array"],
      currentTaskId: null,
      orphanedTaskIds: [],
      inconsistentTasks: [],
      details: "Roadmap is missing a valid 'tasks' array",
    };
  }

  const tasks = rawTasks as Array<Record<string, unknown>>;
  const taskMap = new Map<string, Record<string, unknown>>();
  for (const t of tasks) {
    const id = t["id"];
    if (typeof id === "string") {
      taskMap.set(id, t);
    }
  }

  const rawCurrentTaskId = raw["current_task_id"];
  const currentTaskId = typeof rawCurrentTaskId === "string" ? rawCurrentTaskId : null;

  // Check orphaned current_task_id
  if (currentTaskId) {
    const currentTask = taskMap.get(currentTaskId);
    if (!currentTask) {
      driftTypes.push("orphaned_current_task");
      orphanedTaskIds.push(currentTaskId);
      inconsistentTasks.push({
        taskId: currentTaskId,
        actualStatus: "missing",
        expectedStatus: "none",
        reason: "current_task_id points to a task that does not exist in roadmap",
      });
    } else {
      const taskStatus = currentTask["status"];
      if (taskStatus === "completed" || taskStatus === "cancelled") {
        driftTypes.push("orphaned_current_task");
        inconsistentTasks.push({
          taskId: currentTaskId,
          actualStatus: String(taskStatus),
          expectedStatus: "none",
          reason: `current_task_id points to task with terminal status '${taskStatus}'`,
        });
      }
    }
  }

  // Check task statuses
  const maxRetries = options.maxRetries ?? 3;
  for (const t of tasks) {
    const id = String(t["id"] ?? "unknown");
    const status = String(t["status"] ?? "");
    const retryCountRaw = t["retry_count"];
    const retryCount = typeof retryCountRaw === "number" ? retryCountRaw : 0;

    if (status === "in_progress" && id !== currentTaskId) {
      driftTypes.push("stale_in_progress");
      inconsistentTasks.push({
        taskId: id,
        actualStatus: status,
        expectedStatus: "approved",
        reason: "Task is marked in_progress but is not the active current_task_id",
      });
    }

    if (retryCount >= maxRetries && (status === "in_progress" || status === "approved")) {
      driftTypes.push("inconsistent_task_status");
      inconsistentTasks.push({
        taskId: id,
        actualStatus: status,
        expectedStatus: "failed",
        reason: `Task exceeded max retries (${retryCount}/${maxRetries}) but remains ${status}`,
      });
    }
  }

  const hasDrift = driftTypes.length > 0;
  const uniqueDriftTypes = Array.from(new Set(driftTypes));

  return {
    hasDrift,
    corrupted: uniqueDriftTypes.includes("corrupted_json") || uniqueDriftTypes.includes("missing_tasks_array"),
    driftTypes: uniqueDriftTypes,
    currentTaskId,
    orphanedTaskIds,
    inconsistentTasks,
    details: hasDrift ? `Detected drift: ${uniqueDriftTypes.join(", ")}` : "No drift detected",
  };
}

export function reconcileRoadmapState(
  roadmapData: unknown,
  drift: RoadmapDrift,
  checkpointRoadmap?: unknown,
): {
  reconciledData: Record<string, unknown>;
  result: ReconciliationResult;
} {
  const actionsApplied: ReconciliationAction[] = [];

  if (drift.corrupted) {
    if (checkpointRoadmap && typeof checkpointRoadmap === "object") {
      const checkpointObj = checkpointRoadmap as Record<string, unknown>;
      const chkCurrentTaskId = typeof checkpointObj["current_task_id"] === "string"
        ? checkpointObj["current_task_id"]
        : null;
      actionsApplied.push({
        action: "restore_roadmap_backup",
        details: "Restored roadmap structure from valid checkpoint",
      });
      return {
        reconciledData: checkpointObj,
        result: {
          reconciled: true,
          actionsApplied,
          restoredRoadmap: true,
          previousCurrentTaskId: drift.currentTaskId,
          newCurrentTaskId: chkCurrentTaskId,
          summary: "Roadmap restored from stable checkpoint due to structure corruption",
        },
      };
    }
  }

  const base =
    roadmapData && typeof roadmapData === "object"
      ? (JSON.parse(JSON.stringify(roadmapData)) as Record<string, unknown>)
      : ({ project: "Software Factory", tasks: [], current_task_id: null } as Record<string, unknown>);

  const prevTaskId = typeof base["current_task_id"] === "string" ? base["current_task_id"] : null;
  let newTaskId = prevTaskId;

  // Clear orphaned current_task_id
  if (drift.driftTypes.includes("orphaned_current_task")) {
    base["current_task_id"] = null;
    newTaskId = null;
    actionsApplied.push({
      action: "clear_current_task",
      taskId: prevTaskId,
      details: `Cleared orphaned current_task_id '${prevTaskId}'`,
    });
  }

  // Reconcile inconsistent tasks
  const baseTasks = base["tasks"];
  if (Array.isArray(baseTasks)) {
    for (const inc of drift.inconsistentTasks) {
      const task = (baseTasks as Array<Record<string, unknown>>).find((t) => t["id"] === inc.taskId);
      if (task) {
        task["status"] = inc.expectedStatus;
        if (inc.expectedStatus === "failed") {
          task["last_error"] = `Reconciled: ${inc.reason}`;
        }
        actionsApplied.push({
          action: "reset_task_status",
          taskId: inc.taskId,
          details: `Reset status from '${inc.actualStatus}' to '${inc.expectedStatus}': ${inc.reason}`,
        });
      }
    }
  }

  return {
    reconciledData: base,
    result: {
      reconciled: actionsApplied.length > 0,
      actionsApplied,
      restoredRoadmap: false,
      previousCurrentTaskId: prevTaskId,
      newCurrentTaskId: newTaskId,
      summary: actionsApplied.length > 0
        ? `Reconciliation applied ${actionsApplied.length} fix(es): ${actionsApplied.map((a) => a.action).join(", ")}`
        : "No reconciliation actions needed",
    },
  };
}
