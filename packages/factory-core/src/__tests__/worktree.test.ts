import { describe, expect, it } from "vitest";
import {
  canExecuteConcurrently,
  ConcurrentExecutionConfigSchema,
  ConcurrentExecutionStatusSchema,
  detectFileOverlap,
  evaluateReconciliationOutcome,
  formatWorktreeCleanupLog,
  generateWorktreeBranch,
  generateWorktreePath,
  parseWorktreeConflictFiles,
  WorktreeConflictDetailsSchema,
  WorktreeInfoSchema,
  WorktreeReconciliationResultSchema,
  WorktreeStatusSchema,
} from "../worktree.js";

describe("worktree isolation and concurrent execution types and helpers", () => {
  it("validates WorktreeStatusSchema enum values", () => {
    expect(WorktreeStatusSchema.parse("active")).toBe("active");
    expect(WorktreeStatusSchema.parse("reconciled")).toBe("reconciled");
    expect(WorktreeStatusSchema.parse("conflicted")).toBe("conflicted");
    expect(WorktreeStatusSchema.parse("cleaned")).toBe("cleaned");
    expect(WorktreeStatusSchema.parse("failed")).toBe("failed");
    expect(() => WorktreeStatusSchema.parse("invalid_status")).toThrow();
  });

  it("validates WorktreeInfoSchema with strict schema checks", () => {
    const validInfo = {
      taskId: "T-EVOLVE-001",
      worktreePath: "/root/projects/software-factory/.worktrees/t-evolve-001",
      branch: "factory/t-evolve-001",
      baseBranch: "main",
      createdAt: "2026-10-17T01:00:00Z",
      status: "active" as const,
      commitSha: "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2",
    };
    const parsed = WorktreeInfoSchema.parse(validInfo);
    expect(parsed.taskId).toBe("T-EVOLVE-001");
    expect(parsed.status).toBe("active");

    // Rejects unexpected fields due to strictObject
    expect(() =>
      WorktreeInfoSchema.parse({ ...validInfo, unexpectedKey: true }),
    ).toThrow();
  });

  it("validates WorktreeConflictDetailsSchema", () => {
    const conflict = {
      hasConflict: true,
      conflictingFiles: ["src/index.ts", "package.json"],
      baseBranch: "main",
      branch: "factory/t-002",
      baseSha: "1111111111111111111111111111111111111111",
      headSha: "2222222222222222222222222222222222222222",
      error: "Merge conflict in 2 file(s)",
    };
    const parsed = WorktreeConflictDetailsSchema.parse(conflict);
    expect(parsed.hasConflict).toBe(true);
    expect(parsed.conflictingFiles).toEqual(["src/index.ts", "package.json"]);
  });

  it("validates WorktreeReconciliationResultSchema", () => {
    const cleanReconciliation = {
      success: true,
      reconciledSha: "abcdef1234567890abcdef1234567890abcdef12",
      baseBranch: "main",
      branch: "factory/t-003",
      hasConflict: false,
      conflictingFiles: [],
      reverified: true,
      verificationPassed: true,
    };
    const parsed = WorktreeReconciliationResultSchema.parse(cleanReconciliation);
    expect(parsed.success).toBe(true);
    expect(parsed.reverified).toBe(true);
  });

  it("validates ConcurrentExecutionConfigSchema and default values", () => {
    const config = ConcurrentExecutionConfigSchema.parse({});
    expect(config.maxConcurrentTasks).toBe(1);
    expect(config.baseBranch).toBe("main");
    expect(config.cleanupOnExit).toBe(true);
    expect(config.reconcileOnSuccess).toBe(true);
    expect(config.verificationTimeout).toBe(300);

    const custom = ConcurrentExecutionConfigSchema.parse({
      maxConcurrentTasks: 4,
      worktreeRootDir: "/custom/worktrees",
      baseBranch: "develop",
    });
    expect(custom.maxConcurrentTasks).toBe(4);
    expect(custom.worktreeRootDir).toBe("/custom/worktrees");
    expect(custom.baseBranch).toBe("develop");
  });

  it("validates ConcurrentExecutionStatusSchema", () => {
    const status = {
      activeTasks: [
        {
          taskId: "T-01",
          worktreePath: "/repo/.worktrees/t-01",
          branch: "factory/t-01",
          baseBranch: "main",
          createdAt: "2026-10-17T01:00:00Z",
          status: "active" as const,
        },
      ],
      completedTasks: ["T-00"],
      failedTasks: [],
      conflictedTasks: [],
      availableSlots: 2,
    };
    const parsed = ConcurrentExecutionStatusSchema.parse(status);
    expect(parsed.activeTasks).toHaveLength(1);
    expect(parsed.availableSlots).toBe(2);
  });

  it("generates correct worktree path and branch names", () => {
    expect(generateWorktreePath("/root/projects/software-factory", "T-EVOLVE-123")).toBe(
      "/root/projects/software-factory/.worktrees/t-evolve-123",
    );
    expect(generateWorktreePath("/repo/", "TASK/SPECIAL")).toBe(
      "/repo/.worktrees/task-special",
    );

    expect(generateWorktreeBranch("T-EVOLVE-123")).toBe("factory/t-evolve-123");
    expect(generateWorktreeBranch("TASK_01", "worktree")).toBe("worktree/task_01");
  });

  it("parses conflict files accurately from git merge outputs", () => {
    const gitOutput = `
CONFLICT (content): Merge conflict in src/server.ts
CONFLICT (modify/delete): test/app.test.ts was deleted in HEAD and modified in base.
UU lib/utils.ts
100644 1111111111111111111111111111111111111111 1	packages/core/src/index.ts
`;
    const conflicts = parseWorktreeConflictFiles(gitOutput);
    expect(conflicts).toContain("src/server.ts");
    expect(conflicts).toContain("test/app.test.ts");
    expect(conflicts).toContain("lib/utils.ts");
    expect(conflicts).toContain("packages/core/src/index.ts");
    expect(conflicts).toEqual([
      "lib/utils.ts",
      "packages/core/src/index.ts",
      "src/server.ts",
      "test/app.test.ts",
    ]);
  });

  it("detects overlapping files between concurrent tasks", () => {
    const taskA = ["src/api.ts", "src/auth.ts", "package.json"];
    const taskB = ["src/client.ts", "src/auth.ts"];
    const taskC = ["src/docs.md", "README.md"];

    expect(detectFileOverlap(taskA, taskB)).toEqual(["src/auth.ts"]);
    expect(detectFileOverlap(taskA, taskC)).toEqual([]);

    expect(canExecuteConcurrently({ files: taskA }, { files: taskB })).toBe(false);
    expect(canExecuteConcurrently({ files: taskA }, { files: taskC })).toBe(true);
    expect(canExecuteConcurrently({}, { files: taskB })).toBe(true);
  });

  it("evaluates reconciliation outcome correctly", () => {
    const conflictResult = evaluateReconciliationOutcome({
      hasConflict: true,
      error: "Merge conflict in foo.ts",
    });
    expect(conflictResult.success).toBe(false);
    expect(conflictResult.status).toBe("conflicted");
    expect(conflictResult.error).toBe("Merge conflict in foo.ts");

    const failedVerificationResult = evaluateReconciliationOutcome({
      hasConflict: false,
      reverified: true,
      verificationPassed: false,
      error: "Typecheck failed",
    });
    expect(failedVerificationResult.success).toBe(false);
    expect(failedVerificationResult.status).toBe("failed");
    expect(failedVerificationResult.error).toBe("Typecheck failed");

    const cleanResult = evaluateReconciliationOutcome({
      hasConflict: false,
      reverified: true,
      verificationPassed: true,
    });
    expect(cleanResult.success).toBe(true);
    expect(cleanResult.status).toBe("reconciled");
  });

  it("formats workspace cleanup log messages consistently", () => {
    const successLog = formatWorktreeCleanupLog("T-123", "/path/.worktrees/t-123", true);
    expect(successLog).toBe(
      "Workspace cleanup for T-123: worktree at /path/.worktrees/t-123 cleanly removed",
    );

    const failLog = formatWorktreeCleanupLog("T-123", "/path/.worktrees/t-123", false);
    expect(failLog).toBe(
      "Workspace cleanup for T-123: worktree at /path/.worktrees/t-123 failed to remove",
    );
  });
});
