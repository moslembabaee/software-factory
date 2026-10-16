import { describe, expect, it } from "vitest";
import {
  canAutoMerge,
  formatPullRequestBody,
  generateBranchName,
  getPullRequestReviewers,
  buildPullRequestMetadata,
  createPullRequestPayload,
  MaintainersSchema,
  PullRequestMetadataSchema,
  PullRequestSchema,
  RegressionContextSchema,
  BugfixTaskSchema,
  parseCiErrorLogs,
  generateBugfixTask,
  ReviewRoleSchema,
  ReviewDecisionSchema,
  ReviewFindingSchema,
  ReviewEvaluationSchema,
  ConsensusPolicySchema,
  ConsensusReviewGateResultSchema,
  evaluateSecurityReview,
  evaluateLintReview,
  dispatchParallelReviews,
  evaluateConsensusReviewGate,
  MergeStateStatusSchema,
  MergeQueueStatusSchema,
  ConflictDetailsSchema,
  RebaseResultSchema,
  MergeQueueEntrySchema,
  detectConflicts,
  needsRebase,
  createMergeQueueEntry,
  prioritizeMergeQueue,
  evaluateRebaseOutcome,
  formatConflictComment,
} from "../pr-lifecycle.js";

describe("pr-lifecycle domain logic and schemas", () => {
  it("generates standardized and sanitized git branch names", () => {
    expect(generateBranchName("T-EVOLVE-1792116220-1")).toBe(
      "factory/t-evolve-1792116220-1",
    );
    expect(generateBranchName("T-007")).toBe("factory/t-007");
    expect(generateBranchName("feature/special!@#_123", "feat")).toBe(
      "feat/feature-special-123",
    );
  });

  it("rejects empty IDs and unsafe branch prefixes", () => {
    expect(() => generateBranchName("!!!")).toThrow("Invalid task ID");
    expect(() => generateBranchName("T-1", "../main")).toThrow(
      "Invalid task ID",
    );
    expect(generateBranchName("T".repeat(200))).toHaveLength(128);
  });

  it("formats rich PR markdown body with task metadata, verification gate, and reviewers", () => {
    const body = formatPullRequestBody({
      taskId: "T-EVOLVE-1792116220-1",
      title: "Automated Pull Request Lifecycle",
      branch: "factory/t-evolve-1792116220-1",
      baseBranch: "main",
      description: "Implement automated branch and PR generation",
      phase: "Continuous Polish & Evolution",
      assignedAgent: "claude",
      verificationCmd: "npm run typecheck && npm test",
      reviewers: ["moslembabaee"],
      requirements: ["Create task branches"],
      acceptanceCriteria: ["CI passes"],
      verificationGates: ["No regression"],
      issueNumber: 25,
    });

    expect(body).toContain("T-EVOLVE-1792116220-1");
    expect(body).toContain("Continuous Polish & Evolution");
    expect(body).toContain("factory/t-evolve-1792116220-1");
    expect(body).toContain("npm run typecheck && npm test");
    expect(body).toContain("@moslembabaee");
    expect(body).toContain("Closes #25");
    expect(body).toContain("- Create task branches");
    expect(body).toContain("- CI passes");
    expect(body).toContain("- No regression");
    expect(body).toContain("<!-- factory-task-id: T-EVOLVE-1792116220-1 -->");
    expect(body).toContain(
      "<!-- factory-branch: factory/t-evolve-1792116220-1 -->",
    );
  });

  it("correctly determines when a PR can be auto-merged", () => {
    const gate = evaluateConsensusReviewGate([
      evaluateSecurityReview("const x = 1;"),
      evaluateLintReview("const x = 1;"),
    ]);
    expect(canAutoMerge("passed", "open")).toBe(false);
    expect(canAutoMerge("passed", "open", null)).toBe(false);
    expect(canAutoMerge("passed", "open", gate)).toBe(true);
    expect(canAutoMerge("passed", "review_requested", gate)).toBe(true);
    expect(canAutoMerge("passed", "ci_passed", gate)).toBe(true);
    expect(canAutoMerge("passed", "approved", gate)).toBe(true);
    expect(canAutoMerge("passed", "draft", gate)).toBe(false);
    expect(canAutoMerge("unknown", "open", gate)).toBe(false);
    expect(canAutoMerge("pending", "open", gate)).toBe(false);
    expect(canAutoMerge("failed", "open", gate)).toBe(false);
    expect(canAutoMerge("passed", "closed", gate)).toBe(false);
    expect(canAutoMerge("passed", "merged", gate)).toBe(false);
  });

  it("validates PullRequestMetadataSchema", () => {
    const valid = {
      taskId: "T-100",
      title: "Title",
      branch: "factory/t-100",
      baseBranch: "main",
      description: "Description",
      phase: "Phase 1",
      reviewers: ["moslembabaee"],
    };
    expect(PullRequestMetadataSchema.parse(valid)).toMatchObject(valid);

    expect(() =>
      PullRequestMetadataSchema.parse({
        ...valid,
        taskId: "",
      }),
    ).toThrow();
  });

  it("validates PullRequestSchema", () => {
    const pr = {
      number: 10,
      url: "https://github.com/moslembabaee/software-factory/pull/10",
      branch: "factory/t-10",
      baseBranch: "main",
      title: "PR Title",
      status: "open",
      reviewers: ["moslembabaee"],
      ciStatus: "passed",
      createdAt: new Date().toISOString(),
    };
    expect(PullRequestSchema.parse(pr)).toMatchObject(pr);

    expect(() =>
      PullRequestSchema.parse({
        ...pr,
        url: "invalid-url",
      }),
    ).toThrow();
  });

  it("validates MaintainersSchema and extracts unique GitHub reviewers", () => {
    const maintainers = {
      authorized_approvers: ["moslembabaee"],
      reviewers: ["reviewer-1", "reviewer-2", "reviewer-1"],
      approval_keywords: ["/approve", "LGTM"],
      auto_triage: true,
    };
    expect(MaintainersSchema.parse(maintainers)).toMatchObject({
      authorized_approvers: ["moslembabaee"],
      reviewers: ["reviewer-1", "reviewer-2", "reviewer-1"],
    });

    const extracted = getPullRequestReviewers(maintainers);
    expect(extracted).toEqual(["reviewer-1", "reviewer-2"]);

    // Fallback to authorized_approvers when reviewers list is omitted
    expect(
      getPullRequestReviewers({ authorized_approvers: ["lead-architect"] }),
    ).toEqual(["lead-architect"]);

    // Rejects invalid GitHub usernames
    expect(() =>
      getPullRequestReviewers({
        reviewers: ["-invalid", "valid-user"],
      }),
    ).toThrow("Maintainer reviewers must be valid GitHub usernames");
  });

  it("builds PR metadata and formatted payload from roadmap task and maintainers", () => {
    const task = {
      id: "T-ISSUE-25",
      title: "Issue #25: feat: Automated Pull Request Lifecycle",
      description: "Automated PR lifecycle and git branch management",
      phase: "Community & Issues",
      assigned_agent: "claude",
      verification_cmd: "npm run typecheck && npm test",
      requirements: [
        "Automated branch creation",
        "Assign reviewers from maintainers.json",
      ],
      acceptance_criteria: ["CI passes and auto-merges"],
      verification_gates: ["npm run typecheck && npm test"],
      github_issue_number: 25,
    };
    const maintainers = {
      authorized_approvers: ["moslembabaee"],
      reviewers: ["moslembabaee"],
    };

    const metadata = buildPullRequestMetadata(task, maintainers);
    expect(metadata.taskId).toBe("T-ISSUE-25");
    expect(metadata.branch).toBe("factory/t-issue-25");
    expect(metadata.baseBranch).toBe("main");
    expect(metadata.reviewers).toEqual(["moslembabaee"]);
    expect(metadata.issueNumber).toBe(25);
    expect(metadata.requirements).toEqual([
      "Automated branch creation",
      "Assign reviewers from maintainers.json",
    ]);

    const payload = createPullRequestPayload(task, maintainers);
    expect(payload.title).toBe(
      "feat(T-ISSUE-25): Issue #25: feat: Automated Pull Request Lifecycle",
    );
    expect(payload.branch).toBe("factory/t-issue-25");
    expect(payload.reviewers).toEqual(["moslembabaee"]);
    expect(payload.body).toContain("T-ISSUE-25");
    expect(payload.body).toContain("factory/t-issue-25");
    expect(payload.body).toContain("@moslembabaee");
    expect(payload.body).toContain("Closes #25");
    expect(payload.body).toContain("Automated branch creation");
  });

  it("parses Vitest and TypeScript error logs into regression context", () => {
    const log = `
FAIL packages/factory-core/src/__tests__/pr-lifecycle.test.ts > pr-lifecycle domain logic
AssertionError: expected false to be true
    at /root/projects/software-factory/packages/factory-core/src/__tests__/pr-lifecycle.test.ts:72:5
packages/factory-core/src/pr-lifecycle.ts(45,10): error TS2322: Type 'string' is not assignable to type 'number'.
`;
    const regression = parseCiErrorLogs(log);
    expect(regression.failingTests).toContain(
      "packages/factory-core/src/__tests__/pr-lifecycle.test.ts",
    );
    expect(regression.errorMessages).toContain(
      "AssertionError: expected false to be true",
    );
    expect(regression.errorMessages).toContain(
      "error TS2322: Type 'string' is not assignable to type 'number'.",
    );
    expect(regression.failingFiles).toContain(
      "packages/factory-core/src/pr-lifecycle.ts",
    );
    expect(regression.stackTraces.length).toBeGreaterThan(0);
    expect(regression.summary).toContain("CI regression");
    expect(RegressionContextSchema.parse(regression)).toMatchObject(regression);
  });

  it("parses Python unittest error logs and stack traces into regression context", () => {
    const log = `
======================================================================
ERROR: test_timeout_kills_descendants_before_returning (test_orchestrator.TransportTests.test_timeout_kills_descendants_before_returning)
----------------------------------------------------------------------
Traceback (most recent call last):
  File "/root/projects/software-factory/tests/runtime/test_orchestrator.py", line 484, in test_timeout_kills_descendants_before_returning
    return f.read()
ProcessLookupError: [Errno 3] No such process
`;
    const regression = parseCiErrorLogs(log);
    expect(regression.failingTests).toContain(
      "test_timeout_kills_descendants_before_returning (test_orchestrator.TransportTests.test_timeout_kills_descendants_before_returning)",
    );
    expect(regression.errorMessages).toContain(
      "ProcessLookupError: [Errno 3] No such process",
    );
    expect(regression.failingFiles).toContain(
      "tests/runtime/test_orchestrator.py",
    );
    expect(regression.stackTraces.length).toBeGreaterThan(0);
    expect(regression.stackTraces[0]).toContain("ProcessLookupError");
    expect(regression.summary).toContain("test_timeout_kills_descendants");
    expect(RegressionContextSchema.parse(regression)).toMatchObject(regression);
  });

  it("generates a focused, valid BugfixTask from parent task and regression context", () => {
    const parent = {
      id: "T-EVOLVE-1792116220-1",
      title: "Automated Pull Request Lifecycle",
      phase: "Continuous Polish & Evolution",
      assignedAgent: "claude",
      verificationCmd: "npm run typecheck && npm test",
      branch: "factory/t-evolve-1792116220-1",
      githubIssueNumber: 25,
    };
    const regression = {
      failingTests: ["test_pr_lifecycle.py"],
      errorMessages: ["AssertionError: 1 !== 0"],
      stackTraces: ["AssertionError: 1 !== 0\n    at test.ts:10:5"],
      failingFiles: ["packages/factory-core/src/pr-lifecycle.ts"],
      rawLogTail: "Error log snippet",
      summary: "CI regression in 1 test(s): test_pr_lifecycle.py",
    };

    const bugfix = generateBugfixTask(parent, regression);
    expect(bugfix.id).toBe("T-EVOLVE-1792116220-1-FIX");
    expect(bugfix.parentTaskId).toBe("T-EVOLVE-1792116220-1");
    expect(bugfix.isBugfix).toBe(true);
    expect(bugfix.status).toBe("approved");
    expect(bugfix.targetBranch).toBe("factory/t-evolve-1792116220-1");
    expect(bugfix.description).toContain("Autonomous Self-Healing Bugfix");
    expect(bugfix.description).toContain("test_pr_lifecycle.py");
    expect(bugfix.description).toContain("AssertionError: 1 !== 0");
    expect(bugfix.description).toContain("Parent Issue #25");
    expect(bugfix.githubIssueNumber).toBe(25);
    expect(BugfixTaskSchema.parse(bugfix)).toMatchObject(bugfix);
  });
  it("normalizes Actions timestamps, ANSI colors, nested test names and TAP failures", () => {
    const context = parseCiErrorLogs(
      [
        "unit\tRun tests\t2026-10-16T00:00:00.000Z  \x1b[31mFAIL tests/unit.test.ts > suite > regression\x1b[0m",
        "unit\tRun tests\t2026-10-16T00:00:00.000Z AssertionError: expected true",
        "unit\tRun tests\t2026-10-16T00:00:00.000Z     at src/worker.ts:8:3",
        "  × handles (nested) arguments (12ms)",
        "not ok 2 - repairs regression",
        "FAILED tests/test_ci.py::test_regression - AssertionError",
        "src/index.ts(1,2): error TS2322: wrong type",
      ].join("\n"),
    );
    expect(context.failingTests).toEqual(
      expect.arrayContaining([
        "tests/unit.test.ts",
        "tests/unit.test.ts > suite > regression",
        "handles (nested) arguments",
        "repairs regression",
        "tests/test_ci.py::test_regression",
      ]),
    );
    expect(context.errorMessages).toEqual([
      "AssertionError: expected true",
      "error TS2322: wrong type",
    ]);
    expect(context.stackTraces).toEqual(["at src/worker.ts:8:3"]);
    expect(context.failingFiles).toContain("src/index.ts");
    expect(context.rawLogTail).not.toContain("\x1b");
  });

  it("bounds malformed traceback parsing, repeated diagnostics and oversized CI logs", () => {
    const context = parseCiErrorLogs(
      "x".repeat(1_000_000) +
        "\nTraceback (most recent call last):\n" +
        Array.from(
          { length: 1000 },
          (_, i) => `    at src/worker${String(i)}.ts:1:2`,
        ).join("\n") +
        "\nTypeError: bad\nTypeError: bad\n",
    );
    expect(context.errorMessages).toEqual(["TypeError: bad"]);
    expect(context.failingFiles.length).toBeLessThanOrEqual(30);
    expect(context.stackTraces.length).toBeLessThanOrEqual(30);
    expect(context.rawLogTail?.length).toBeLessThanOrEqual(4000);
    expect(RegressionContextSchema.safeParse(context).success).toBe(true);
    expect(parseCiErrorLogs("").summary).toBe("CI build/test failure detected");
  });

  it("retains repair provenance and scope and sanitizes fallback branch names", () => {
    const context = parseCiErrorLogs(
      "Error: build failed\n    at worker.ts:2:3",
    );
    expect(context.failingFiles).toContain("worker.ts");
    const task = generateBugfixTask(
      {
        id: "T-special!@#_42",
        title: "Original feature",
        commitSha: "a".repeat(40),
        tenantId: "00000000-0000-4000-8000-000000000001",
        projectId: "00000000-0000-4000-8000-000000000002",
      },
      context,
      "-FIX-2",
    );
    expect(task.id).toBe("T-special!@#_42-FIX-2");
    expect(task.targetBranch).toBe("factory/t-special-42");
    expect(task.sourceCommitSha).toBe("a".repeat(40));
    expect(task.verificationCmd).toBe("npm run typecheck && npm test");
    expect(BugfixTaskSchema.safeParse(task).success).toBe(true);
    expect(
      BugfixTaskSchema.safeParse({ ...task, status: "invented" }).success,
    ).toBe(false);
  });

  it("evaluates security reviews correctly: rejects secrets, eval, shell injection and RLS bypass", () => {
    // 1. Clean diff
    const cleanDiff = "diff --git a/src/app.ts b/src/app.ts\n+const x = 42;\n";
    const cleanReview = evaluateSecurityReview(cleanDiff);
    expect(cleanReview.passed).toBe(true);
    expect(cleanReview.decision).toBe("approved");
    expect(cleanReview.findings).toHaveLength(0);
    expect(cleanReview.score).toBe(100);

    // 2. Secret leak
    const secretDiff =
      "diff --git a/src/auth.ts b/src/auth.ts\n+const apiKey = 'sk-1234567890abcdef12345678';\n";
    const secretReview = evaluateSecurityReview(secretDiff);
    expect(secretReview.passed).toBe(false);
    expect(secretReview.decision).toBe("rejected");
    expect(
      secretReview.findings.some((f) => f.ruleId === "SEC-TOKEN-LEAK"),
    ).toBe(true);

    // 3. Private key
    const privKeyDiff =
      "diff --git a/keys.pem b/keys.pem\n+-----BEGIN RSA PRIVATE KEY-----\nMIIE...\n";
    const keyReview = evaluateSecurityReview(privKeyDiff);
    expect(keyReview.passed).toBe(false);
    expect(keyReview.findings.some((f) => f.ruleId === "SEC-PRIVATE-KEY")).toBe(
      true,
    );

    // 4. Unsafe eval
    const evalDiff =
      "diff --git a/src/run.ts b/src/run.ts\n+eval(userInput);\n";
    const evalReview = evaluateSecurityReview(evalDiff);
    expect(evalReview.passed).toBe(false);
    expect(
      evalReview.findings.some((f) => f.ruleId === "SEC-UNSAFE-EVAL"),
    ).toBe(true);

    // 5. Shell injection
    const shellDiff =
      "diff --git a/src/worker.py b/src/worker.py\n+subprocess.run(cmd, shell=True)\n";
    const shellReview = evaluateSecurityReview(shellDiff);
    expect(shellReview.passed).toBe(false);
    expect(
      shellReview.findings.some((f) => f.ruleId === "SEC-SHELL-INJECTION"),
    ).toBe(true);

    // 6. RLS bypass
    const rlsDiff =
      "diff --git a/infra/schema.sql b/infra/schema.sql\n+DROP POLICY tenant_isolation ON projects;\n";
    const rlsReview = evaluateSecurityReview(rlsDiff);
    expect(rlsReview.passed).toBe(false);
    expect(rlsReview.findings.some((f) => f.ruleId === "SEC-RLS-BYPASS")).toBe(
      true,
    );

    // 7. Path traversal
    const pathDiff =
      "diff --git a/src/read.ts b/src/read.ts\n+const p = path.join(dir, '../../etc/passwd');\n";
    const pathReview = evaluateSecurityReview(pathDiff);
    expect(pathReview.passed).toBe(false);
    expect(
      pathReview.findings.some((f) => f.ruleId === "SEC-PATH-TRAVERSAL"),
    ).toBe(true);
  });

  it("evaluates linting reviews correctly: rejects debugger, breakpoints, blockers", () => {
    // 1. Clean diff
    const cleanDiff =
      "diff --git a/src/app.ts b/src/app.ts\n+export const x = 1;\n";
    const cleanReview = evaluateLintReview(cleanDiff);
    expect(cleanReview.passed).toBe(true);
    expect(cleanReview.decision).toBe("approved");
    expect(cleanReview.findings).toHaveLength(0);

    // 2. Debugger statement
    const debugDiff = "diff --git a/src/app.ts b/src/app.ts\n+debugger;\n";
    const debugReview = evaluateLintReview(debugDiff);
    expect(debugReview.passed).toBe(false);
    expect(debugReview.decision).toBe("rejected");
    expect(debugReview.findings.some((f) => f.ruleId === "LINT-DEBUGGER")).toBe(
      true,
    );

    // 3. Python breakpoint
    const pyDiff = "diff --git a/src/app.py b/src/app.py\n+pdb.set_trace()\n";
    const pyReview = evaluateLintReview(pyDiff);
    expect(pyReview.passed).toBe(false);
    expect(pyReview.findings.some((f) => f.ruleId === "LINT-BREAKPOINT")).toBe(
      true,
    );

    // 4. Blocker comment
    const blockerDiff =
      "diff --git a/src/app.ts b/src/app.ts\n+// TODO: BLOCKER fix this before release\n";
    const blockerReview = evaluateLintReview(blockerDiff);
    expect(blockerReview.passed).toBe(false);
    expect(
      blockerReview.findings.some((f) => f.ruleId === "LINT-BLOCKER-COMMENT"),
    ).toBe(true);

    // 5. Console.log is warning only (passes with warning)
    const consoleDiff =
      "diff --git a/src/app.ts b/src/app.ts\n+console.log('debugging info');\n";
    const consoleReview = evaluateLintReview(consoleDiff);
    expect(consoleReview.passed).toBe(true);
    expect(
      consoleReview.findings.some((f) => f.ruleId === "LINT-CONSOLE-LOG"),
    ).toBe(true);
  });

  it("dispatches specialized reviews in parallel", async () => {
    const diff =
      "diff --git a/src/calc.ts b/src/calc.ts\n+export function add(a: number, b: number) { return a + b; }\n";
    const evaluations = await dispatchParallelReviews(diff, {
      securityAgent: "custom-sec-bot",
      lintAgent: "custom-lint-bot",
    });

    expect(evaluations).toHaveLength(2);
    expect(evaluations.find((e) => e.role === "security")?.agent).toBe(
      "custom-sec-bot",
    );
    expect(evaluations.find((e) => e.role === "lint")?.agent).toBe(
      "custom-lint-bot",
    );
    expect(evaluations.every((e) => e.passed)).toBe(true);
  });

  it("enforces consensus thresholds and policy checks", () => {
    const passingSec = evaluateSecurityReview(
      "diff --git a/src/a.ts b/src/a.ts\n+const a = 1;\n",
    );
    const passingLint = evaluateLintReview(
      "diff --git a/src/a.ts b/src/a.ts\n+const a = 1;\n",
    );
    const failingSec = evaluateSecurityReview(
      "diff --git a/src/a.ts b/src/a.ts\n+eval(x);\n",
    );
    const failingLint = evaluateLintReview(
      "diff --git a/src/a.ts b/src/a.ts\n+debugger;\n",
    );

    // Both pass -> consensus reached, gate passed
    const passResult = evaluateConsensusReviewGate([passingSec, passingLint]);
    expect(passResult.passed).toBe(true);
    expect(passResult.consensusReached).toBe(true);
    expect(passResult.securityGatePassed).toBe(true);
    expect(passResult.lintGatePassed).toBe(true);
    expect(passResult.approvalCount).toBe(2);
    expect(passResult.summary).toContain("PASSED");

    // Security failure -> blocks gate even if lint passes
    const secFailResult = evaluateConsensusReviewGate([
      failingSec,
      passingLint,
    ]);
    expect(secFailResult.passed).toBe(false);
    expect(secFailResult.securityGatePassed).toBe(false);
    expect(
      secFailResult.policyViolations.some((v) => v.includes("Security policy")),
    ).toBe(true);

    // Lint failure -> blocks gate even if security passes
    const lintFailResult = evaluateConsensusReviewGate([
      passingSec,
      failingLint,
    ]);
    expect(lintFailResult.passed).toBe(false);
    expect(lintFailResult.lintGatePassed).toBe(false);
    expect(
      lintFailResult.policyViolations.some((v) => v.includes("Lint policy")),
    ).toBe(true);

    // Missing required role -> fails policy
    const missingRoleResult = evaluateConsensusReviewGate([passingSec]);
    expect(missingRoleResult.passed).toBe(false);
    expect(
      missingRoleResult.policyViolations.some((v) =>
        v.includes("Missing required review evaluation"),
      ),
    ).toBe(true);

    // Insufficient approvals threshold
    const highThresholdResult = evaluateConsensusReviewGate(
      [passingSec, passingLint],
      {
        minApprovals: 3,
      },
    );
    expect(highThresholdResult.passed).toBe(false);
    expect(
      highThresholdResult.policyViolations.some((v) =>
        v.includes("Consensus threshold not met"),
      ),
    ).toBe(true);
  });

  it("canAutoMerge respects consensus review gate outcome", () => {
    const passedGate = evaluateConsensusReviewGate([
      evaluateSecurityReview("const x = 1;"),
      evaluateLintReview("const x = 1;"),
    ]);
    const failedGate = evaluateConsensusReviewGate([
      evaluateSecurityReview("eval(x);"),
      evaluateLintReview("const x = 1;"),
    ]);

    expect(canAutoMerge("passed", "open", passedGate)).toBe(true);
    expect(canAutoMerge("passed", "approved", passedGate)).toBe(true);
    expect(canAutoMerge("passed", "open", failedGate)).toBe(false);
    expect(canAutoMerge("passed", "approved", failedGate)).toBe(false);
    expect(canAutoMerge("failed", "open", passedGate)).toBe(false);
  });
});

describe("review gate evidence and deadlines", () => {
  const security = evaluateSecurityReview("const safe = true;");
  const lint = evaluateLintReview("const safe = true;");

  it("validates review schemas and consensus defaults", () => {
    expect(ReviewRoleSchema.safeParse("owner").success).toBe(false);
    expect(ReviewDecisionSchema.safeParse("abstain").success).toBe(false);
    expect(
      ReviewFindingSchema.safeParse({
        ruleId: "rule",
        severity: "critical",
        message: "bad",
        line: 0,
      }).success,
    ).toBe(false);
    expect(ReviewEvaluationSchema.parse(security)).toEqual(security);
    expect(
      ReviewEvaluationSchema.safeParse({ ...lint, passed: "true" }).success,
    ).toBe(false);
    expect(ConsensusPolicySchema.parse({}).minApprovals).toBe(2);
    for (const policy of [
      { minApprovals: 0 },
      { approvalThreshold: NaN },
      { approvalThreshold: 1.1 },
    ]) {
      expect(() =>
        evaluateConsensusReviewGate([security, lint], policy),
      ).toThrow();
    }
    expect(
      ConsensusReviewGateResultSchema.parse(
        evaluateConsensusReviewGate([security, lint]),
      ).passed,
    ).toBe(true);
  });

  it("rejects duplicate identities, missing and malformed evidence", () => {
    expect(evaluateConsensusReviewGate([]).passed).toBe(false);
    expect(
      evaluateConsensusReviewGate([
        security,
        { ...lint, agent: security.agent.toUpperCase() },
      ]).passed,
    ).toBe(false);
    expect(evaluateConsensusReviewGate([security, null as never]).passed).toBe(
      false,
    );
    expect(
      evaluateConsensusReviewGate([
        security,
        { ...lint, passed: "true" } as never,
      ]).passed,
    ).toBe(false);
  });

  it("enforces ratios, required role vetoes and global severity policies", () => {
    const extra = { ...lint, role: "general" as const, agent: "general-agent" };
    const reject = {
      ...extra,
      agent: "other-agent",
      passed: false,
      decision: "rejected" as const,
    };
    const reviews = [security, lint, extra, reject];
    expect(
      evaluateConsensusReviewGate(reviews, { approvalThreshold: 0.75 }).passed,
    ).toBe(true);
    expect(
      evaluateConsensusReviewGate(reviews, { approvalThreshold: 0.76 }).passed,
    ).toBe(false);
    expect(
      evaluateConsensusReviewGate([
        ...reviews,
        { ...security, agent: "sec-veto", passed: false, decision: "rejected" },
      ]).securityGatePassed,
    ).toBe(false);
    expect(
      evaluateConsensusReviewGate([
        security,
        lint,
        {
          ...extra,
          findings: [{ ruleId: "ERR", severity: "error", message: "error" }],
        },
      ]).passed,
    ).toBe(false);
  });

  it("runs callbacks concurrently and preserves dispatch order", async () => {
    let started = 0;
    let release = (): void => {};
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const customEvaluators = ["first", "second"].map((agent) => async () => {
      started++;
      if (started === 2) release();
      await barrier;
      return { ...lint, role: "general" as const, agent };
    });
    const reviews = await dispatchParallelReviews("const safe = true;", {
      customEvaluators,
      timeoutMs: 500,
    });
    expect(reviews.map((e) => e.agent)).toEqual([
      "security-agent",
      "lint-agent",
      "first",
      "second",
    ]);
    expect(evaluateConsensusReviewGate(reviews).passed).toBe(true);
  });

  it("turns throws, malformed returns and stalled callbacks into blocking results", async () => {
    let aborted = false;
    const reviews = await dispatchParallelReviews("const safe = true;", {
      timeoutMs: 20,
      customEvaluators: [
        () => {
          throw new Error("sensitive exception");
        },
        () => null as never,
        (signal) => {
          signal.addEventListener("abort", () => {
            aborted = true;
          });
          return new Promise(() => {});
        },
      ],
    });
    expect(reviews).toHaveLength(5);
    expect(reviews.slice(2).every((e) => !e.passed)).toBe(true);
    expect(aborted).toBe(true);
    expect(JSON.stringify(reviews)).not.toContain("sensitive exception");
    expect(
      evaluateConsensusReviewGate(reviews, {
        approvalThreshold: 0,
        blockOnCriticalSeverity: false,
        blockOnErrorSeverity: false,
      }).passed,
    ).toBe(false);
  });

  it("keeps added-line locations correct and redacts credentials in comments", () => {
    const diff =
      "diff --git a/src/auth.ts b/src/auth.ts\n--- a/src/auth.ts\n+++ b/src/auth.ts\n@@ -20,2 +20,3 @@\n const safe = 1;\n-old();\n+// token: ghp_" +
      "a".repeat(24) +
      "\n+eval(input);\n";
    const review = evaluateSecurityReview(diff);
    expect(
      review.findings.find((f) => f.ruleId === "SEC-TOKEN-LEAK")?.line,
    ).toBe(21);
    expect(
      review.findings.find((f) => f.ruleId === "SEC-UNSAFE-EVAL")?.line,
    ).toBe(22);
    expect(JSON.stringify(review)).not.toContain("ghp_");
    expect(
      evaluateSecurityReview("import { x } from '../../utils.js';").passed,
    ).toBe(true);
  });
});

describe("automated PR merge queue, conflict detection, and rebasing", () => {
  const passingGate = evaluateConsensusReviewGate([
    evaluateSecurityReview("const safe = 1;"),
    evaluateLintReview("const safe = 1;"),
  ]);

  it("canAutoMerge respects mergeStateStatus and conflicted/rebasing states", () => {
    // When clean, can merge
    expect(canAutoMerge("passed", "open", passingGate, "clean")).toBe(true);
    expect(canAutoMerge("passed", "open", passingGate, "CLEAN")).toBe(true);

    // Behind, dirty, blocked, draft should reject auto merge
    expect(canAutoMerge("passed", "open", passingGate, "behind")).toBe(false);
    expect(canAutoMerge("passed", "open", passingGate, "dirty")).toBe(false);
    expect(canAutoMerge("passed", "open", passingGate, "blocked")).toBe(false);
    expect(canAutoMerge("passed", "open", passingGate, "draft")).toBe(false);

    // Conflicted, rebasing, rebase_failed PR statuses should reject auto merge
    expect(canAutoMerge("passed", "conflicted", passingGate, "clean")).toBe(false);
    expect(canAutoMerge("passed", "rebasing", passingGate, "clean")).toBe(false);
    expect(canAutoMerge("passed", "rebase_failed", passingGate, "clean")).toBe(false);
  });

  it("validates MergeStateStatusSchema, MergeQueueStatusSchema, ConflictDetailsSchema, and RebaseResultSchema", () => {
    expect(MergeStateStatusSchema.parse("clean")).toBe("clean");
    expect(MergeStateStatusSchema.parse("dirty")).toBe("dirty");
    expect(MergeStateStatusSchema.parse("behind")).toBe("behind");
    expect(() => MergeStateStatusSchema.parse("invalid")).toThrow();

    expect(MergeQueueStatusSchema.parse("queued")).toBe("queued");
    expect(MergeQueueStatusSchema.parse("ready_to_merge")).toBe("ready_to_merge");
    expect(MergeQueueStatusSchema.parse("conflicted")).toBe("conflicted");

    const conflict = {
      hasConflict: true,
      conflictingFiles: ["src/index.ts", "packages/core/app.ts"],
      baseBranch: "main",
      branch: "factory/t-1",
      baseSha: "1111111111111111111111111111111111111111",
      headSha: "2222222222222222222222222222222222222222",
      error: "Conflict in 2 files",
    };
    expect(ConflictDetailsSchema.parse(conflict)).toEqual(conflict);

    const rebase = {
      success: true,
      rebasedSha: "3333333333333333333333333333333333333333",
      baseSha: "1111111111111111111111111111111111111111",
      conflicts: [],
      reverified: true,
      verificationPassed: true,
    };
    expect(RebaseResultSchema.parse(rebase)).toEqual({
      ...rebase,
      error: undefined,
    });
  });

  it("detects conflicts from merge-tree, rebase output, and porcelain status", () => {
    // 1. Output with CONFLICT (content)
    const mergeTreeOutput = `
100644 b1b716105590454bfc4c0247f193a04088f39c7f 1\tsrc/file1.txt
100644 a7453f07505c42ea8d6fdda75fa91710c81c53d6 2\tsrc/file1.txt
100644 ba2906d0666cf726c7eaadd2cd3db615dedfdf3a 3\tsrc/file1.txt

Auto-merging src/file1.txt
CONFLICT (content): Merge conflict in src/file1.txt
`;
    const result1 = detectConflicts(mergeTreeOutput, "main", "factory/t-1");
    expect(result1.hasConflict).toBe(true);
    expect(result1.conflictingFiles).toEqual(["src/file1.txt"]);
    expect(result1.error).toContain("Merge conflict detected in 1 file(s)");

    // 2. Porcelain status with unmerged entries
    const porcelainOutput = `
UU packages/core/src/index.ts
AA packages/core/src/models.ts
M  packages/core/src/clean.ts
`;
    const result2 = detectConflicts(porcelainOutput, "main", "factory/t-2");
    expect(result2.hasConflict).toBe(true);
    expect(result2.conflictingFiles).toEqual([
      "packages/core/src/index.ts",
      "packages/core/src/models.ts",
    ]);

    // 3. Clean output without conflicts
    const cleanOutput = `
Auto-merging src/utils.ts
Merge made by the 'ort' strategy.
`;
    const cleanResult = detectConflicts(cleanOutput, "main", "factory/t-clean");
    expect(cleanResult.hasConflict).toBe(false);
    expect(cleanResult.conflictingFiles).toEqual([]);
    expect(cleanResult.error).toBeUndefined();

    // 4. Raw diff conflict markers
    const markerOutput = `
<<<<<<< HEAD
const a = 1;
=======
const a = 2;
>>>>>>> feature
`;
    const markerResult = detectConflicts(markerOutput, "main", "factory/t-markers");
    expect(markerResult.hasConflict).toBe(true);
  });

  it("needsRebase correctly determines when a PR is behind base branch", () => {
    const shaA = "a".repeat(40);
    const shaB = "b".repeat(40);

    expect(needsRebase(shaA, shaB)).toBe(true);
    expect(needsRebase(shaA, shaA)).toBe(false);
    expect(needsRebase(shaA, shaA, "behind")).toBe(true);
    expect(needsRebase(shaA, shaA, "dirty")).toBe(true);
    expect(needsRebase(shaA, shaA, "clean")).toBe(false);
  });

  it("manages and prioritizes the merge queue correctly", () => {
    const entry1 = createMergeQueueEntry({
      taskId: "T-001",
      prNumber: 101,
      branch: "factory/t-001",
      baseBranch: "main",
      commitSha: "1".repeat(40),
      queuedAt: "2026-10-16T10:00:00Z",
    });

    const entry2 = createMergeQueueEntry({
      taskId: "T-002",
      prNumber: 102,
      branch: "factory/t-002",
      baseBranch: "main",
      commitSha: "2".repeat(40),
      queuedAt: "2026-10-16T10:05:00Z",
    });

    const entry3: typeof entry1 = {
      ...entry2,
      taskId: "T-003",
      prNumber: 103,
      status: "ready_to_merge",
      queuedAt: "2026-10-16T10:10:00Z",
    };

    const entry4: typeof entry1 = {
      ...entry1,
      taskId: "T-004",
      prNumber: 104,
      status: "rebasing",
      queuedAt: "2026-10-16T09:50:00Z",
    };

    expect(entry1.status).toBe("queued");
    expect(entry1.attempts).toBe(0);
    expect(MergeQueueEntrySchema.parse(entry1)).toEqual(entry1);

    const sorted = prioritizeMergeQueue([entry1, entry2, entry3, entry4]);
    expect(sorted.map((e) => e.taskId)).toEqual([
      "T-003", // ready_to_merge
      "T-004", // rebasing
      "T-001", // queued (earlier queuedAt)
      "T-002", // queued (later queuedAt)
    ]);
  });

  it("evaluates rebase outcomes and updates queue entry state", () => {
    const entry = createMergeQueueEntry({
      taskId: "T-001",
      prNumber: 101,
      branch: "factory/t-001",
      baseBranch: "main",
      commitSha: "1".repeat(40),
    });

    // 1. Successful rebase with passing reverification
    const passResult = evaluateRebaseOutcome(entry, {
      success: true,
      rebasedSha: "newsha123",
      conflicts: [],
      reverified: true,
      verificationPassed: true,
    });
    expect(passResult.status).toBe("ready_to_merge");
    expect(passResult.attempts).toBe(1);
    expect(passResult.rebasedCommitSha).toBe("newsha123");
    expect(passResult.verifiedAt).toBeDefined();

    // 2. Successful rebase awaiting reverification
    const pendingVerif = evaluateRebaseOutcome(entry, {
      success: true,
      rebasedSha: "newsha123",
      conflicts: [],
      reverified: false,
    });
    expect(pendingVerif.status).toBe("verifying");
    expect(pendingVerif.attempts).toBe(1);

    // 3. Rebase with conflicts
    const conflictResult = evaluateRebaseOutcome(entry, {
      success: false,
      conflicts: ["src/app.ts"],
      reverified: false,
      error: "Conflict in src/app.ts",
    });
    expect(conflictResult.status).toBe("conflicted");
    expect(conflictResult.conflicts).toEqual(["src/app.ts"]);
    expect(conflictResult.error).toContain("Conflict");

    // 4. Failed reverification
    const failResult = evaluateRebaseOutcome(entry, {
      success: false,
      conflicts: [],
      reverified: true,
      verificationPassed: false,
      error: "Test suite failed",
    });
    expect(failResult.status).toBe("failed");
    expect(failResult.error).toBe("Test suite failed");
  });

  it("formats informative PR conflict comments", () => {
    const conflict = detectConflicts(
      "CONFLICT (content): Merge conflict in src/core.ts\nCONFLICT (content): Merge conflict in src/api.ts",
      "main",
      "factory/t-100",
    );
    const comment = formatConflictComment(conflict);

    expect(comment).toContain("### ⚠️ Autonomous PR Conflict Detected");
    expect(comment).toContain("`main`");
    expect(comment).toContain("`factory/t-100`");
    expect(comment).toContain("- `src/api.ts`");
    expect(comment).toContain("- `src/core.ts`");
    expect(comment).toContain("<!-- factory-conflict-base: main -->");
    expect(comment).toContain("<!-- factory-conflict-branch: factory/t-100 -->");
  });
});
