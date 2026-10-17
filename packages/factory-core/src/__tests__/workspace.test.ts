import { describe, expect, it } from "vitest";
import {
  parseGitStatusPorcelain,
  validateWorkspaceCleanliness,
  createWorkspaceCheckpoint,
  planRollback,
  detectRoadmapDrift,
  reconcileRoadmapState,
  WorkspaceCleanlinessSchema,
  WorkspaceCheckpointSchema,
  RollbackPlanSchema,
  RoadmapDriftSchema,
  ReconciliationResultSchema,
} from "../workspace.js";

describe("Workspace Cleanliness and Git Parsing", () => {
  it("parses empty git status porcelain as clean", () => {
    const status = parseGitStatusPorcelain("", "main", "abc1234");
    expect(status.clean).toBe(true);
    expect(status.changes).toHaveLength(0);
    expect(status.modifiedFiles).toHaveLength(0);
    expect(status.untrackedFiles).toHaveLength(0);
    expect(status.hasIndexLock).toBe(false);
    expect(status.summary).toBe("Workspace is clean");

    const validated = WorkspaceCleanlinessSchema.safeParse(status);
    expect(validated.success).toBe(true);

    const validation = validateWorkspaceCleanliness(status);
    expect(validation.isValid).toBe(true);
    expect(validation.violations).toHaveLength(0);
    expect(validation.recommendedAction).toBe("none");
  });

  it("parses modified, untracked, staged and deleted files", () => {
    const porcelain = [
      " M packages/core/src/file1.ts",
      "M  packages/core/src/file2.ts",
      "?? untracked.txt",
      " D deleted-worktree.ts",
      "R  old-name.ts -> new-name.ts",
    ].join("\n");

    const status = parseGitStatusPorcelain(porcelain, "factory/t-issue-27", "fedcba9", false);
    expect(status.clean).toBe(false);
    expect(status.modifiedFiles).toContain("packages/core/src/file1.ts");
    expect(status.modifiedFiles).toContain("packages/core/src/file2.ts");
    expect(status.untrackedFiles).toContain("untracked.txt");
    expect(status.stagedFiles).toContain("packages/core/src/file2.ts");
    expect(status.deletedFiles).toContain("deleted-worktree.ts");

    const validation = validateWorkspaceCleanliness(status);
    expect(validation.isValid).toBe(false);
    expect(validation.violations.length).toBeGreaterThan(0);
    expect(validation.recommendedAction).toBe("rollback");
  });

  it("detects git index lock and conflicts", () => {
    const porcelain = "UU conflict.txt\n";
    const status = parseGitStatusPorcelain(porcelain, "main", "123456", true);
    expect(status.clean).toBe(false);
    expect(status.hasIndexLock).toBe(true);
    expect(status.conflictFiles).toContain("conflict.txt");

    const validation = validateWorkspaceCleanliness(status);
    expect(validation.isValid).toBe(false);
    expect(validation.violations).toContain("Git index is locked (.git/index.lock exists)");
    expect(validation.recommendedAction).toBe("rollback");
  });

  it("recommends unlock when only index.lock is present without dirty files", () => {
    const status = parseGitStatusPorcelain("", "main", "123456", true);
    expect(status.clean).toBe(false);
    expect(status.hasIndexLock).toBe(true);
    const validation = validateWorkspaceCleanliness(status);
    expect(validation.recommendedAction).toBe("unlock");
  });

  it("recommends clean when only untracked files exist", () => {
    const status = parseGitStatusPorcelain("?? leftover.tmp\n", "main", "123456", false);
    expect(status.clean).toBe(false);
    const validation = validateWorkspaceCleanliness(status);
    expect(validation.recommendedAction).toBe("clean");
  });
});

describe("Workspace Checkpoints and Rollback Planning", () => {
  it("creates and validates a workspace checkpoint", () => {
    const checkpoint = createWorkspaceCheckpoint({
      taskId: "T-ISSUE-27",
      commitSha: "c21dbabc8eda50861d15b84bd2fc77a0bab12ac6",
      branch: "factory/t-issue-27",
      roadmapSnapshot: JSON.stringify({ current_task_id: "T-ISSUE-27", tasks: [] }),
    });

    expect(checkpoint.id).toMatch(/^chk-\d+-[a-z0-9]+$/);
    expect(checkpoint.taskId).toBe("T-ISSUE-27");
    expect(checkpoint.commitSha).toBe("c21dbabc8eda50861d15b84bd2fc77a0bab12ac6");
    expect(checkpoint.branch).toBe("factory/t-issue-27");

    const parsed = WorkspaceCheckpointSchema.safeParse(checkpoint);
    expect(parsed.success).toBe(true);
  });

  it("plans a rollback when task errors or verification fails", () => {
    const porcelain = " M broken.ts\n?? dirty.tmp\n";
    const cleanliness = parseGitStatusPorcelain(porcelain, "main", "abc", true);
    const checkpoint = createWorkspaceCheckpoint({
      taskId: "T-ISSUE-27",
      commitSha: "checkpoint-sha-123",
      branch: "main",
      roadmapSnapshot: '{"tasks":[]}',
    });

    const plan = planRollback(cleanliness, checkpoint, "unrecoverable_task_error");
    expect(plan.strategy).toBe("restore_checkpoint");
    expect(plan.reason).toBe("unrecoverable_task_error");
    expect(plan.targetSha).toBe("checkpoint-sha-123");
    expect(plan.removeLockFiles).toBe(true);
    expect(plan.resetHard).toBe(true);
    expect(plan.cleanUntracked).toBe(true);
    expect(plan.restoreRoadmap).toBe(true);

    const parsed = RollbackPlanSchema.safeParse(plan);
    expect(parsed.success).toBe(true);
  });
});

describe("Roadmap Drift Detection and Reconciliation", () => {
  it("detects corrupted roadmap json or missing tasks", () => {
    const corrupted1 = detectRoadmapDrift("not an object");
    expect(corrupted1.hasDrift).toBe(true);
    expect(corrupted1.corrupted).toBe(true);
    expect(corrupted1.driftTypes).toContain("corrupted_json");

    const corrupted2 = detectRoadmapDrift({ project: "Software Factory" });
    expect(corrupted2.hasDrift).toBe(true);
    expect(corrupted2.corrupted).toBe(true);
    expect(corrupted2.driftTypes).toContain("missing_tasks_array");

    const parsed = RoadmapDriftSchema.safeParse(corrupted1);
    expect(parsed.success).toBe(true);
  });

  it("detects orphaned current_task_id", () => {
    const drift = detectRoadmapDrift({
      project: "Software Factory",
      current_task_id: "T-MISSING",
      tasks: [
        { id: "T-001", status: "completed" },
      ],
    });

    expect(drift.hasDrift).toBe(true);
    expect(drift.driftTypes).toContain("orphaned_current_task");
    expect(drift.orphanedTaskIds).toContain("T-MISSING");
  });

  it("detects terminal task as current_task_id", () => {
    const drift = detectRoadmapDrift({
      project: "Software Factory",
      current_task_id: "T-001",
      tasks: [
        { id: "T-001", status: "completed" },
      ],
    });

    expect(drift.hasDrift).toBe(true);
    expect(drift.driftTypes).toContain("orphaned_current_task");
    expect(drift.inconsistentTasks[0]?.actualStatus).toBe("completed");
  });

  it("detects inconsistent in_progress tasks and exceeded retries", () => {
    const drift = detectRoadmapDrift(
      {
        project: "Software Factory",
        current_task_id: "T-002",
        tasks: [
          { id: "T-001", status: "in_progress", retry_count: 0 },
          { id: "T-002", status: "in_progress", retry_count: 4 },
        ],
      },
      { maxRetries: 3 },
    );

    expect(drift.hasDrift).toBe(true);
    expect(drift.driftTypes).toContain("stale_in_progress");
    expect(drift.driftTypes).toContain("inconsistent_task_status");

    const stale = drift.inconsistentTasks.find((t) => t.taskId === "T-001");
    expect(stale?.expectedStatus).toBe("approved");

    const exceeded = drift.inconsistentTasks.find((t) => t.taskId === "T-002");
    expect(exceeded?.expectedStatus).toBe("failed");
  });

  it("reconciles corrupted roadmap from checkpoint snapshot", () => {
    const checkpointRoadmap = {
      project: "Software Factory",
      current_task_id: null,
      tasks: [{ id: "T-001", status: "approved" }],
    };

    const drift = detectRoadmapDrift("corrupted string");
    const { reconciledData, result } = reconcileRoadmapState("corrupted string", drift, checkpointRoadmap);

    expect(result.reconciled).toBe(true);
    expect(result.restoredRoadmap).toBe(true);
    expect(reconciledData).toEqual(checkpointRoadmap);

    const parsed = ReconciliationResultSchema.safeParse(result);
    expect(parsed.success).toBe(true);
  });

  it("reconciles drift by clearing orphaned current_task_id and failing exceeded tasks", () => {
    const driftedRoadmap = {
      project: "Software Factory",
      current_task_id: "T-NONEXISTENT",
      tasks: [
        { id: "T-001", status: "in_progress", retry_count: 0 },
        { id: "T-002", status: "approved", retry_count: 5 },
      ],
    };

    const drift = detectRoadmapDrift(driftedRoadmap, { maxRetries: 3 });
    const { reconciledData, result } = reconcileRoadmapState(driftedRoadmap, drift);

    expect(result.reconciled).toBe(true);
    expect(result.restoredRoadmap).toBe(false);
    expect(reconciledData["current_task_id"]).toBeNull();

    const tasks = reconciledData["tasks"] as Array<Record<string, unknown>>;
    const t1 = tasks.find((t) => t["id"] === "T-001");
    expect(t1?.["status"]).toBe("approved");

    const t2 = tasks.find((t) => t["id"] === "T-002");
    expect(t2?.["status"]).toBe("failed");
    expect(String(t2?.["last_error"])).toContain("Reconciled:");

    const parsed = ReconciliationResultSchema.safeParse(result);
    expect(parsed.success).toBe(true);
  });
});
