import { describe, expect, it } from "vitest";
import {
  parseGitWorktreeList,
  detectOverlappingFiles,
  planParallelWorktreeExecution,
  evaluateMergeReconciliation,
  sanitizeTaskBranchName,
  WorktreeInfoSchema,
  ConflictDetectionResultSchema,
  MergeReconciliationResultSchema,
  WorktreeCleanupResultSchema,
  ParallelExecutionPlanSchema,
} from "../worktree.js";

describe("Worktree Management & Concurrency Schemas", () => {
  it("sanitizes task branch names", () => {
    expect(sanitizeTaskBranchName("T-EVOLVE-001")).toBe("factory/t-evolve-001");
    expect(sanitizeTaskBranchName("T_SPECIAL#123", "feature")).toBe("feature/t-special-123");
  });

  it("parses git worktree list --porcelain output", () => {
    const porcelain = [
      "worktree /root/projects/software-factory",
      "HEAD a1b2c3d4e5f678901234567890abcdef12345678",
      "branch refs/heads/main",
      "",
      "worktree /root/projects/software-factory/.worktrees/task-t-007",
      "HEAD 9876543210abcdef9876543210abcdef98765432",
      "branch refs/heads/factory/t-007",
      "",
    ].join("\n");

    const list = parseGitWorktreeList(porcelain);
    expect(list).toHaveLength(2);

    expect(list[0]?.path).toBe("/root/projects/software-factory");
    expect(list[0]?.branch).toBe("main");

    expect(list[1]?.path).toBe("/root/projects/software-factory/.worktrees/task-t-007");
    expect(list[1]?.branch).toBe("factory/t-007");
    expect(list[1]?.taskId).toBe("t-007");

    const validated = WorktreeInfoSchema.safeParse(list[1]);
    expect(validated.success).toBe(true);
  });

  it("detects overlapping file conflicts across concurrent tasks", () => {
    const taskFiles = {
      "T-001": ["src/server.ts", "src/auth.ts"],
      "T-002": ["src/client.ts", "src/auth.ts"],
      "T-003": ["docs/readme.md"],
    };

    const overlaps = detectOverlappingFiles(taskFiles);
    expect(overlaps["T-001"]).toBeDefined();
    expect(overlaps["T-001"]?.overlappingTasks).toContain("T-002");
    expect(overlaps["T-001"]?.files).toContain("src/auth.ts");

    expect(overlaps["T-002"]?.overlappingTasks).toContain("T-001");
    expect(overlaps["T-003"]).toBeUndefined();
  });

  it("plans parallel worktree execution", () => {
    const tasks = [
      { id: "T-001" },
      { id: "T-002" },
      { id: "T-003" },
    ];
    const fileChanges = {
      "T-001": ["src/index.ts"],
      "T-002": ["src/index.ts"],
    };

    const plan = planParallelWorktreeExecution(tasks, "/tmp/worktrees", 3, fileChanges);
    expect(plan.tasks).toHaveLength(3);
    expect(plan.maxConcurrency).toBe(3);
    expect(plan.tasks[0]?.worktreePath).toBe("/tmp/worktrees/task-t-001");
    expect(plan.tasks[0]?.branch).toBe("factory/t-001");
    expect(plan.overlappingConflicts["T-001"]?.overlappingTasks).toContain("T-002");

    const validated = ParallelExecutionPlanSchema.safeParse(plan);
    expect(validated.success).toBe(true);
  });

  it("evaluates merge reconciliation correctly", () => {
    // 1. Not verified -> reject
    const unverifiedEval = evaluateMergeReconciliation(
      {
        hasConflict: false,
        conflictingFiles: [],
        baseBranch: "main",
        taskBranch: "factory/t-1",
        overlappingTasks: [],
        error: null,
      },
      false,
    );
    expect(unverifiedEval.canMerge).toBe(false);
    expect(unverifiedEval.reason).toContain("Task verification must succeed");

    // 2. Conflict detected -> reject
    const conflictEval = evaluateMergeReconciliation(
      {
        hasConflict: true,
        conflictingFiles: ["src/app.ts", "package.json"],
        baseBranch: "main",
        taskBranch: "factory/t-1",
        overlappingTasks: [],
        error: "Merge conflict in 2 file(s)",
      },
      true,
    );
    expect(conflictEval.canMerge).toBe(false);
    expect(conflictEval.reason).toContain("Automated conflict detection failed: 2 conflicting file(s)");

    // 3. Clean and verified -> approve
    const cleanEval = evaluateMergeReconciliation(
      {
        hasConflict: false,
        conflictingFiles: [],
        baseBranch: "main",
        taskBranch: "factory/t-1",
        overlappingTasks: [],
        error: null,
      },
      true,
    );
    expect(cleanEval.canMerge).toBe(true);
    expect(cleanEval.reason).toContain("No conflicts detected");
  });

  it("validates schemas for conflict and cleanup results", () => {
    const conflictResult = {
      hasConflict: true,
      conflictingFiles: ["src/index.ts"],
      baseBranch: "main",
      taskBranch: "factory/t-1",
      overlappingTasks: ["T-002"],
      error: "Conflict detected",
    };
    expect(ConflictDetectionResultSchema.safeParse(conflictResult).success).toBe(true);

    const mergeResult = {
      success: true,
      taskId: "T-001",
      mergedSha: "abcdef1234567890abcdef1234567890abcdef12",
      baseBranch: "main",
      taskBranch: "factory/t-001",
      conflictDetected: false,
      conflictingFiles: [],
      error: null,
      cleanedUp: true,
      timestamp: new Date().toISOString(),
    };
    expect(MergeReconciliationResultSchema.safeParse(mergeResult).success).toBe(true);

    const cleanupResult = {
      success: true,
      taskId: "T-001",
      path: "/tmp/worktrees/task-t-001",
      branchDeleted: true,
      error: null,
    };
    expect(WorktreeCleanupResultSchema.safeParse(cleanupResult).success).toBe(true);
  });
});
