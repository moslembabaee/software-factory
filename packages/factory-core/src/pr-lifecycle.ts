import { z } from "zod";
import { BuildStatusSchema } from "./build.js";

export const PullRequestStatusSchema = z.enum([
  "draft",
  "open",
  "review_requested",
  "ci_pending",
  "ci_passed",
  "ci_failed",
  "approved",
  "merged",
  "closed",
  "review_pending",
  "review_passed",
  "review_failed",
  "conflicted",
  "rebasing",
  "rebase_failed",
]);

export const MergeStateStatusSchema = z.enum([
  "clean",
  "dirty",
  "behind",
  "blocked",
  "unknown",
  "unstable",
  "draft",
  "has_hooks",
]);

export const MergeQueueStatusSchema = z.enum([
  "queued",
  "rebasing",
  "verifying",
  "ready_to_merge",
  "merged",
  "conflicted",
  "failed",
]);

export const ConflictDetailsSchema = z.strictObject({
  hasConflict: z.boolean(),
  conflictingFiles: z.array(z.string()),
  baseBranch: z.string().min(1),
  branch: z.string().min(1),
  baseSha: z.string().optional(),
  headSha: z.string().optional(),
  error: z.string().optional(),
});

export const RebaseResultSchema = z.strictObject({
  success: z.boolean(),
  rebasedSha: z.string().optional(),
  baseSha: z.string().optional(),
  conflicts: z.array(z.string()).default([]),
  reverified: z.boolean().default(false),
  verificationPassed: z.boolean().optional(),
  error: z.string().optional(),
});

export const MergeQueueEntrySchema = z.strictObject({
  taskId: z.string().min(1),
  prNumber: z.number().int().positive(),
  branch: z.string().min(1),
  baseBranch: z.string().min(1),
  commitSha: z.string().min(1),
  status: MergeQueueStatusSchema,
  queuedAt: z.string(),
  attempts: z.number().int().nonnegative().default(0),
  conflicts: z.array(z.string()).default([]),
  error: z.string().nullable().optional(),
  rebasedCommitSha: z.string().nullable().optional(),
  verifiedAt: z.string().nullable().optional(),
  mergedAt: z.string().nullable().optional(),
});

export type MergeStateStatus = z.infer<typeof MergeStateStatusSchema>;
export type MergeQueueStatus = z.infer<typeof MergeQueueStatusSchema>;
export type ConflictDetails = z.infer<typeof ConflictDetailsSchema>;
export type RebaseResult = z.infer<typeof RebaseResultSchema>;
export type MergeQueueEntry = z.infer<typeof MergeQueueEntrySchema>;

export const CiStatusSchema = z.enum([
  "pending",
  "passed",
  "failed",
  "unknown",
]);

export const ReviewRoleSchema = z.enum([
  "security",
  "lint",
  "architecture",
  "general",
]);

export const ReviewDecisionSchema = z.enum([
  "approved",
  "rejected",
  "changes_requested",
]);

export const ReviewFindingSchema = z.strictObject({
  ruleId: z.string().min(1),
  severity: z.enum(["info", "warning", "error", "critical"]),
  message: z.string().min(1),
  file: z.string().optional(),
  line: z.number().int().positive().optional(),
  snippet: z.string().max(500).optional(),
});

export const ReviewEvaluationSchema = z.strictObject({
  agent: z.string().trim().min(1),
  role: ReviewRoleSchema,
  decision: ReviewDecisionSchema,
  passed: z.boolean(),
  score: z.number().min(0).max(100).optional(),
  findings: z.array(ReviewFindingSchema),
  summary: z.string().max(2000),
  timestamp: z.string(),
});

export const ConsensusPolicySchema = z.strictObject({
  minApprovals: z.number().int().min(1).default(2),
  approvalThreshold: z.number().min(0).max(1).default(0.66),
  requireSecurityApproval: z.boolean().default(true),
  requireLintApproval: z.boolean().default(true),
  blockOnCriticalSeverity: z.boolean().default(true),
  blockOnErrorSeverity: z.boolean().default(true),
  requiredRoles: z.array(ReviewRoleSchema).default(["security", "lint"]),
});

export const ConsensusReviewGateResultSchema = z.strictObject({
  passed: z.boolean(),
  consensusReached: z.boolean(),
  securityGatePassed: z.boolean(),
  lintGatePassed: z.boolean(),
  approvalCount: z.number().int().nonnegative(),
  rejectionCount: z.number().int().nonnegative(),
  totalEvaluations: z.number().int().nonnegative(),
  policyViolations: z.array(z.string()),
  evaluations: z.array(ReviewEvaluationSchema),
  summary: z.string(),
  evaluatedAt: z.string(),
});

export type ReviewRole = z.infer<typeof ReviewRoleSchema>;
export type ReviewDecision = z.infer<typeof ReviewDecisionSchema>;
export type ReviewFinding = z.infer<typeof ReviewFindingSchema>;
export type ReviewEvaluation = z.infer<typeof ReviewEvaluationSchema>;
export type ConsensusPolicy = z.infer<typeof ConsensusPolicySchema>;
export type ConsensusReviewGateResult = z.infer<
  typeof ConsensusReviewGateResultSchema
>;

export const PullRequestMetadataSchema = z.strictObject({
  taskId: z.string().min(1),
  title: z.string().min(1),
  branch: z.string().min(1),
  baseBranch: z.string().min(1),
  description: z.string(),
  phase: z.string(),
  assignedAgent: z.string().optional(),
  verificationCmd: z.string().optional(),
  reviewers: z.array(z.string()),
  requirements: z.array(z.string()).optional(),
  acceptanceCriteria: z.array(z.string()).optional(),
  verificationGates: z.array(z.string()).optional(),
  issueNumber: z.number().int().positive().nullable().optional(),
});

export const PullRequestSchema = z.strictObject({
  number: z.number().int().positive(),
  url: z.url(),
  branch: z.string().min(1),
  baseBranch: z.string().min(1),
  title: z.string().min(1),
  status: PullRequestStatusSchema,
  reviewers: z.array(z.string()),
  ciStatus: CiStatusSchema,
  mergeCommitSha: z.string().nullable().optional(),
  createdAt: z.string(),
  mergedAt: z.string().nullable().optional(),
  consensusReview: ConsensusReviewGateResultSchema.optional(),
  mergeStateStatus: MergeStateStatusSchema.optional(),
  conflictDetails: ConflictDetailsSchema.optional(),
  rebaseResult: RebaseResultSchema.optional(),
});

export type PullRequestStatus = z.infer<typeof PullRequestStatusSchema>;
export type CiStatus = z.infer<typeof CiStatusSchema>;
export type PullRequestMetadata = z.infer<typeof PullRequestMetadataSchema>;
export type PullRequest = z.infer<typeof PullRequestSchema>;

export function generateBranchName(taskId: string, prefix = "factory"): string {
  const sanitized = taskId
    .replace(/[^a-zA-Z0-9\-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase()
    .slice(0, 120);
  if (!sanitized || !/^[a-zA-Z0-9-]+$/.test(prefix)) {
    throw new TypeError("Invalid task ID or branch prefix");
  }
  return `${prefix}/${sanitized}`;
}

export function formatPullRequestBody(metadata: PullRequestMetadata): string {
  const lines: string[] = [
    "### 🤖 Autonomous Software Factory Pull Request",
    "",
    `- **Task ID:** \`${metadata.taskId}\``,
    `- **Phase:** ${metadata.phase}`,
    `- **Branch:** \`${metadata.branch}\``,
  ];
  if (metadata.assignedAgent) {
    lines.push(`- **Assigned Agent:** \`${metadata.assignedAgent}\``);
  }
  lines.push("", "#### Description & Requirements", metadata.description, "");
  for (const [heading, values] of [
    ["Requirements", metadata.requirements],
    ["Acceptance Criteria", metadata.acceptanceCriteria],
    ["Verification Gates", metadata.verificationGates],
  ] as const) {
    if (values?.length) {
      lines.push(`#### ${heading}`, ...values.map((value) => `- ${value}`), "");
    }
  }
  if (metadata.verificationCmd) {
    lines.push(
      "#### Quality Gate Verification",
      `\`\`\`bash\n${metadata.verificationCmd}\n\`\`\``,
      "Verification outcome: **PASSED**",
      "",
    );
  }
  if (metadata.reviewers.length > 0) {
    lines.push(
      "#### Reviewers",
      `Assigned: ${metadata.reviewers.map((r) => `@${r}`).join(", ")}`,
      "",
    );
  }
  if (metadata.issueNumber) {
    lines.push(`Reference: Closes #${String(metadata.issueNumber)}`, "");
  }
  lines.push(`<!-- factory-task-id: ${metadata.taskId} -->`);
  lines.push(`<!-- factory-branch: ${metadata.branch} -->`);
  return lines.join("\n");
}

export function canAutoMerge(
  ciStatus: CiStatus,
  prStatus: PullRequestStatus,
  consensusGate?: ConsensusReviewGateResult | null,
  mergeStateStatus?: string | null,
): boolean {
  if (
    !consensusGate?.passed ||
    !consensusGate.consensusReached ||
    !consensusGate.securityGatePassed ||
    !consensusGate.lintGatePassed ||
    consensusGate.policyViolations.length > 0
  ) {
    return false;
  }
  if (
    prStatus === "conflicted" ||
    prStatus === "rebase_failed" ||
    prStatus === "rebasing"
  ) {
    return false;
  }
  if (mergeStateStatus) {
    const normalized = mergeStateStatus.toLowerCase();
    if (
      normalized === "dirty" ||
      normalized === "behind" ||
      normalized === "blocked" ||
      normalized === "draft"
    ) {
      return false;
    }
  }
  return (
    ciStatus === "passed" &&
    (prStatus === "open" ||
      prStatus === "review_requested" ||
      prStatus === "ci_passed" ||
      prStatus === "approved" ||
      prStatus === "review_passed")
  );
}

export function detectConflicts(
  gitOutput: string,
  baseBranch: string,
  branch: string,
  options?: { baseSha?: string; headSha?: string },
): ConflictDetails {
  const files = new Set<string>();

  // 1. CONFLICT (content): Merge conflict in <file>
  for (const match of gitOutput.matchAll(
    /CONFLICT\s+\([^)]+\):\s+Merge conflict in\s+(\S+)/g,
  )) {
    if (match[1]) files.add(match[1].replace(/['"]/g, "").trim());
  }

  // 2. CONFLICT (modify/delete): <file> deleted in ... and modified in ...
  for (const match of gitOutput.matchAll(
    /CONFLICT\s+\([^)]+\):\s+(\S+)\s+(?:deleted|modified|was)/g,
  )) {
    if (match[1]) files.add(match[1].replace(/['"]/g, "").trim());
  }

  // 3. Stage entries in merge-tree: <mode> <sha> <stage>\t<path>
  for (const match of gitOutput.matchAll(
    /^\d+\s+[0-9a-f]{40}\s+[123]\t(.+)$/gm,
  )) {
    if (match[1]) files.add(match[1].replace(/['"]/g, "").trim());
  }

  // 4. Porcelain status: UU file, AA file, etc.
  for (const match of gitOutput.matchAll(
    /^(?:UU|AA|UD|DU|UA|AU)\s+(.+)$/gm,
  )) {
    if (match[1]) files.add(match[1].replace(/['"]/g, "").trim());
  }

  // 5. Explicit diff conflict markers: <<<<<<< ... ======= ... >>>>>>>
  const hasMarkers =
    gitOutput.includes("<<<<<<<") &&
    gitOutput.includes("=======") &&
    gitOutput.includes(">>>>>>>");

  if (hasMarkers && files.size === 0) {
    const diffMatch = /^diff --git a\/(.+?) b\/(.+?)$/m.exec(gitOutput);
    if (diffMatch?.[2] ?? diffMatch?.[1]) {
      files.add((diffMatch[2] ?? diffMatch[1])!.trim());
    } else {
      files.add("conflict-markers");
    }
  }

  const conflictingFiles = Array.from(files).sort();
  const hasConflict = conflictingFiles.length > 0 || hasMarkers;

  return ConflictDetailsSchema.parse({
    hasConflict,
    conflictingFiles,
    baseBranch,
    branch,
    baseSha: options?.baseSha,
    headSha: options?.headSha,
    error: hasConflict
      ? `Merge conflict detected in ${String(conflictingFiles.length)} file(s): ${conflictingFiles.slice(0, 5).join(", ")}`
      : undefined,
  });
}

export function needsRebase(
  currentBaseSha: string,
  prBaseSha: string,
  mergeStateStatus?: MergeStateStatus | string | null,
): boolean {
  if (mergeStateStatus) {
    const normalized = mergeStateStatus.toLowerCase();
    if (normalized === "behind" || normalized === "dirty") {
      return true;
    }
  }
  return Boolean(currentBaseSha && prBaseSha && currentBaseSha !== prBaseSha);
}

export function createMergeQueueEntry(params: {
  taskId: string;
  prNumber: number;
  branch: string;
  baseBranch: string;
  commitSha: string;
  queuedAt?: string;
}): MergeQueueEntry {
  return MergeQueueEntrySchema.parse({
    taskId: params.taskId,
    prNumber: params.prNumber,
    branch: params.branch,
    baseBranch: params.baseBranch,
    commitSha: params.commitSha,
    status: "queued",
    queuedAt: params.queuedAt ?? new Date().toISOString(),
    attempts: 0,
    conflicts: [],
  });
}

export function prioritizeMergeQueue(
  entries: MergeQueueEntry[],
): MergeQueueEntry[] {
  const statusPriority: Record<MergeQueueStatus, number> = {
    ready_to_merge: 0,
    verifying: 1,
    rebasing: 2,
    queued: 3,
    conflicted: 4,
    failed: 5,
    merged: 6,
  };
  return [...entries].sort((a, b) => {
    const pA = statusPriority[a.status] ?? 99;
    const pB = statusPriority[b.status] ?? 99;
    if (pA !== pB) return pA - pB;
    return new Date(a.queuedAt).getTime() - new Date(b.queuedAt).getTime();
  });
}

export function evaluateRebaseOutcome(
  entry: MergeQueueEntry,
  rebaseResult: RebaseResult,
): MergeQueueEntry {
  const attempts = entry.attempts + 1;
  if (rebaseResult.success) {
    if (rebaseResult.reverified && rebaseResult.verificationPassed) {
      return {
        ...entry,
        status: "ready_to_merge",
        attempts,
        rebasedCommitSha: rebaseResult.rebasedSha ?? entry.commitSha,
        verifiedAt: new Date().toISOString(),
        error: null,
        conflicts: [],
      };
    }
    return {
      ...entry,
      status: "verifying",
      attempts,
      rebasedCommitSha: rebaseResult.rebasedSha ?? entry.commitSha,
      error: null,
      conflicts: [],
    };
  }
  if (rebaseResult.conflicts.length > 0) {
    return {
      ...entry,
      status: "conflicted",
      attempts,
      conflicts: rebaseResult.conflicts,
      error: rebaseResult.error ?? "Merge conflict detected during rebase",
    };
  }
  return {
    ...entry,
    status: "failed",
    attempts,
    error: rebaseResult.error ?? "Rebase or reverification failed",
  };
}

export function formatConflictComment(
  conflict: ConflictDetails,
  rebaseResult?: RebaseResult | null,
): string {
  const lines = [
    "### ⚠️ Autonomous PR Conflict Detected",
    "",
    `Base branch \`${conflict.baseBranch}\` has advanced and conflicts were detected on branch \`${conflict.branch}\`.`,
    "",
    "#### Conflicting Files",
    ...conflict.conflictingFiles.map((f) => `- \`${f}\``),
    "",
  ];
  if (conflict.error) {
    lines.push(
      "#### Diagnostic Details",
      `\`\`\`\n${conflict.error}\n\`\`\``,
      "",
    );
  }
  if (rebaseResult?.error && rebaseResult.error !== conflict.error) {
    lines.push(
      "#### Rebase Error",
      `\`\`\`\n${rebaseResult.error}\n\`\`\``,
      "",
    );
  }
  lines.push(
    "#### Next Steps",
    "- Automatic rebase failed due to content conflicts.",
    "- Rebase your branch onto the latest base branch and resolve conflicting hunks.",
    "- Ensure the verification suite passes locally before updating.",
    "",
    `<!-- factory-conflict-base: ${conflict.baseBranch} -->`,
    `<!-- factory-conflict-branch: ${conflict.branch} -->`,
  );
  return lines.join("\n");
}

export const RegressionContextSchema = z.strictObject({
  failingTests: z.array(z.string().max(1000)).max(30),
  errorMessages: z.array(z.string().max(1000)).max(30),
  stackTraces: z.array(z.string().max(4000)).max(30),
  failingFiles: z.array(z.string().max(1000)).max(30),
  rawLogTail: z.string().max(4000).optional(),
  summary: z.string().max(300),
  sourceCommitSha: z.string().optional(),
  prNumber: z.number().int().positive().optional(),
});

export const BugfixTaskSchema = z.strictObject({
  id: z.string().min(1),
  parentTaskId: z.string().min(1),
  title: z.string().min(1),
  description: z.string(),
  phase: z.string(),
  status: BuildStatusSchema,
  assignedAgent: z.string(),
  verificationCmd: z.string(),
  targetBranch: z.string().min(1),
  sourceCommitSha: z.string().optional(),
  tenantId: z.uuid().optional(),
  projectId: z.uuid().optional(),
  regressionContext: RegressionContextSchema,
  isBugfix: z.literal(true),
  githubIssueNumber: z.number().int().positive().nullable().optional(),
});

export type RegressionContext = z.infer<typeof RegressionContextSchema>;
export type BugfixTask = z.infer<typeof BugfixTaskSchema>;

export function parseCiErrorLogs(logs: string): RegressionContext {
  // Bound both parsing work and stored context; scan lines rather than matching
  // multiline traceback blocks with potentially unbounded backtracking.
  const lines = logs
    .slice(-64_000)
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .split(/\r?\n/)
    .map((line) =>
      line
        .slice(0, 4000)
        .replace(/^.*?\d{4}-\d\d-\d\dT[\d:.]+Z\s*/, "")
        .replace(/##\[error\]/g, "")
        .trimEnd(),
    );
  const failingTests: string[] = [];
  const errorMessages: string[] = [];
  const failingFiles: string[] = [];
  const stackTraces: string[] = [];
  const add = (values: string[], value: string, limit = 1000): void => {
    const bounded = value.trim().slice(0, limit);
    if (bounded && !values.includes(bounded) && values.length < 30)
      values.push(bounded);
  };
  let trace: string[] = [];
  let pythonTrace = false;
  const flushTrace = (): void => {
    add(stackTraces, trace.join("\n"), 4000);
    trace = [];
    pythonTrace = false;
  };
  for (const line of lines) {
    const clean = line.trim();
    let match = /^(?:FAIL|ERROR):\s*(.+)/.exec(clean);
    if (match?.[1]) add(failingTests, match[1]);
    match = /^FAIL\s+(\S+)(.*)/.exec(clean);
    if (match?.[1]) {
      add(failingTests, match[1]);
      add(failingFiles, match[1]);
      if (match[2]?.trim()) add(failingTests, clean.slice(5));
    }
    match = /^(?:✖|✕|×|not ok \d+\s*-?)\s+(.+)/.exec(clean);
    if (match?.[1] && !match[1].startsWith("failing tests")) {
      add(failingTests, match[1].replace(/\s+\(\d+(?:\.\d+)?m?s\)$/, ""));
    }
    match = /^FAILED\s+(\S+)/.exec(clean);
    if (match?.[1]) add(failingTests, match[1]);
    match = /test at (.+)/.exec(clean);
    if (match?.[1]) add(failingTests, match[1]);
    match = /error (TS\d+:[^\n]+)/.exec(clean);
    if (match?.[1]) add(errorMessages, `error ${match[1]}`);
    const error =
      /^(?:E\s+)?((?:[A-Z]\w*(?:Error|Exception)|Error|Exception)(?:\s*\[[^\]]+\])?:.*)/.exec(
        clean,
      );
    if (error?.[1]) add(errorMessages, error[1]);
    if (clean.startsWith("Traceback (most recent call last):")) {
      flushTrace();
      trace = [line];
      pythonTrace = true;
    } else if (pythonTrace) {
      trace.push(line);
      if (error || trace.length >= 30) flushTrace();
    } else if (/^(?:at|❯)\s+/.test(clean)) {
      trace.push(line);
      if (trace.length >= 30) flushTrace();
    } else if (trace.length) {
      flushTrace();
    }
    for (const file of line.matchAll(
      /(?:[A-Za-z0-9_.@/-]+\.(?:tsx?|jsx?|mjs|cjs|py))(?=[:(\s"']|$)/g,
    )) {
      const path = file[0];
      if (!path.includes("node_modules/") && !path.startsWith("/usr/")) {
        add(failingFiles, path.split("software-factory/").at(-1) ?? path);
      }
    }
  }
  flushTrace();
  let summary = failingTests.length
    ? `CI regression in ${String(failingTests.length)} test(s): ${failingTests.slice(0, 3).join(", ")}`
    : "CI build/test failure detected";
  if (errorMessages.length) {
    summary = `${failingTests.length ? `${summary}. Error: ` : "CI failure: "}${errorMessages[0] ?? ""}`;
  }
  return {
    failingTests,
    errorMessages,
    stackTraces,
    failingFiles,
    rawLogTail: lines.join("\n").slice(-4000),
    summary: summary.slice(0, 300),
  };
}

export function generateBugfixTask(
  parentTask: {
    id: string;
    title: string;
    phase?: string;
    assignedAgent?: string;
    verificationCmd?: string;
    targetBranch?: string;
    commitSha?: string;
    tenantId?: string;
    projectId?: string;
    branch?: string;
    issueNumber?: number | null;
    githubIssueNumber?: number | null;
  },
  regression: RegressionContext,
  suffix = "-FIX",
): BugfixTask {
  const branch =
    parentTask.targetBranch ||
    parentTask.branch ||
    generateBranchName(parentTask.id);
  const issueNum =
    parentTask.githubIssueNumber ?? parentTask.issueNumber ?? null;

  const lines: string[] = [
    "### 🤖 Autonomous Self-Healing Bugfix",
    "",
    `Remediate CI build regression on branch \`${branch}\`.`,
    "",
    `- **Parent Task:** \`${parentTask.id}\` — ${parentTask.title}`,
    `- **Target Branch:** \`${branch}\``,
    "",
    "#### Regression Summary",
    regression.summary,
    "",
  ];

  if (regression.failingTests.length > 0) {
    lines.push(
      "#### Failing Tests",
      ...regression.failingTests.map((t) => `- \`${t}\``),
      "",
    );
  }
  if (regression.errorMessages.length > 0) {
    lines.push(
      "#### Error Messages",
      ...regression.errorMessages.map((e) => `- ${e}`),
      "",
    );
  }
  if (regression.failingFiles.length > 0) {
    lines.push(
      "#### Implicated Files",
      ...regression.failingFiles.map((f) => `- \`${f}\``),
      "",
    );
  }
  const firstTrace = regression.stackTraces[0];
  if (firstTrace) {
    lines.push("#### Diagnostic Stack Trace", "```", firstTrace, "```", "");
  } else if (regression.rawLogTail) {
    lines.push(
      "#### Error Log Snippet",
      "```",
      regression.rawLogTail.slice(-1500),
      "```",
      "",
    );
  }
  if (issueNum) {
    lines.push(`Reference: Parent Issue #${String(issueNum)}`, "");
  }
  lines.push(`<!-- factory-bugfix-for: ${parentTask.id} -->`);
  lines.push(`<!-- factory-branch: ${branch} -->`);

  return {
    id: `${parentTask.id}${suffix}`,
    parentTaskId: parentTask.id,
    title:
      `Bugfix: Remediate CI failure in ${parentTask.id}: ${regression.summary}`.slice(
        0,
        120,
      ),
    description: lines.join("\n"),
    phase: parentTask.phase || "Continuous Polish & Evolution",
    status: "approved",
    assignedAgent: parentTask.assignedAgent || "claude",
    verificationCmd:
      parentTask.verificationCmd || "npm run typecheck && npm test",
    targetBranch: branch,
    sourceCommitSha: parentTask.commitSha,
    tenantId: parentTask.tenantId,
    projectId: parentTask.projectId,
    regressionContext: regression,
    isBugfix: true,
    githubIssueNumber: issueNum,
  };
}

export interface DiffFileInput {
  path: string;
  patch?: string;
  content?: string;
}

export type ReviewInput = string | { files: DiffFileInput[] } | DiffFileInput[];

function extractLinesFromReviewInput(
  input: ReviewInput,
): Array<{ file: string; lineNum: number; line: string }> {
  const result: Array<{ file: string; lineNum: number; line: string }> = [];

  if (typeof input === "string") {
    let currentFile = "unknown";
    let lineNum = 1;
    const isGitDiff = input.includes("diff --git") || input.includes("--- a/");
    for (const rawLine of input.split(/\r?\n/)) {
      const trimmed = rawLine.trim();
      const fileMatch =
        /^diff --git a\/(.+?) b\/(.+?)$/.exec(trimmed) ||
        /^\+\+\+ b\/(.+?)$/.exec(trimmed);
      if (fileMatch) {
        currentFile = fileMatch[2] ?? fileMatch[1] ?? currentFile;
        lineNum = 1;
        continue;
      }
      if (rawLine.startsWith("@@")) {
        const hunkMatch = /@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(rawLine);
        if (hunkMatch?.[1]) {
          lineNum = parseInt(hunkMatch[1], 10);
        }
        continue;
      }
      if (isGitDiff) {
        if (rawLine.startsWith("+") && !rawLine.startsWith("+++")) {
          result.push({ file: currentFile, lineNum, line: rawLine.slice(1) });
          lineNum++;
        } else if (rawLine.startsWith(" ")) {
          lineNum++;
        }
      } else {
        result.push({ file: currentFile, lineNum, line: rawLine });
        lineNum++;
      }
    }
  } else {
    const files = Array.isArray(input) ? input : input.files;
    for (const f of files) {
      const text = f.patch ?? f.content ?? "";
      let lineNum = 1;
      const isPatch = Boolean(f.patch);
      for (const rawLine of text.split(/\r?\n/)) {
        if (isPatch) {
          const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(rawLine);
          if (hunk?.[1]) {
            lineNum = Number(hunk[1]);
            continue;
          }
          if (rawLine.startsWith("+") && !rawLine.startsWith("+++")) {
            result.push({ file: f.path, lineNum, line: rawLine.slice(1) });
            lineNum++;
          } else if (rawLine.startsWith(" ")) {
            lineNum++;
          }
        } else {
          result.push({ file: f.path, lineNum, line: rawLine });
          lineNum++;
        }
      }
    }
  }

  return result;
}

export function evaluateSecurityReview(
  input: ReviewInput,
  agent = "security-agent",
): ReviewEvaluation {
  const lines = extractLinesFromReviewInput(input);
  const findings: ReviewFinding[] = [];

  for (const { file, lineNum, line } of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    if (/-----BEGIN[ A-Z0-9_-]*PRIVATE KEY-----/i.test(line)) {
      findings.push({
        ruleId: "SEC-PRIVATE-KEY",
        severity: "critical",
        message: "Private encryption key embedded in source",
        file,
        line: lineNum,
        snippet: line.slice(0, 100),
      });
    } else if (
      /\b(?:sk-[a-zA-Z0-9]{20,}|gh[pousr]_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16})\b/.test(
        line,
      )
    ) {
      findings.push({
        ruleId: "SEC-TOKEN-LEAK",
        severity: "critical",
        message: "High-entropy API token or cloud credential detected",
        file,
        line: lineNum,
        snippet: line.slice(0, 100),
      });
    } else if (
      /(?:api[_-]?key|secret|password|auth[_-]?token)\s*[:=]\s*["'][A-Za-z0-9_\-]{16,}["']/i.test(
        line,
      ) &&
      !line.includes("process.env")
    ) {
      findings.push({
        ruleId: "SEC-HARDCODED-SECRET",
        severity: "critical",
        message:
          "Hardcoded secret or authentication credential assignment detected",
        file,
        line: lineNum,
        snippet: line.slice(0, 100),
      });
    }

    if (trimmed.startsWith("//") || trimmed.startsWith("#")) continue;
    if (/\beval\s*\(/.test(line)) {
      findings.push({
        ruleId: "SEC-UNSAFE-EVAL",
        severity: "critical",
        message: "Unsafe eval() execution detected",
        file,
        line: lineNum,
        snippet: line.slice(0, 100),
      });
    }
    if (
      /\bos\.system\s*\(/.test(line) ||
      /\bsubprocess\.(?:call|Popen|run)\([^)]*shell\s*=\s*True/.test(line)
    ) {
      findings.push({
        ruleId: "SEC-SHELL-INJECTION",
        severity: "critical",
        message: "Unsafe subprocess invocation with shell=True or os.system",
        file,
        line: lineNum,
        snippet: line.slice(0, 100),
      });
    }
    if (/\bchild_process\b.*\bexec\s*\(/.test(line)) {
      findings.push({
        ruleId: "SEC-UNSAFE-EXEC",
        severity: "error",
        message:
          "Unquoted child_process.exec invocation (use execFile or parameter array)",
        file,
        line: lineNum,
        snippet: line.slice(0, 100),
      });
    }

    if (
      /\bDROP\s+POLICY\b/i.test(line) ||
      /\bDISABLE\s+ROW\s+LEVEL\s+SECURITY\b/i.test(line)
    ) {
      findings.push({
        ruleId: "SEC-RLS-BYPASS",
        severity: "critical",
        message: "Tenant Row-Level Security bypass or policy drop detected",
        file,
        line: lineNum,
        snippet: line.slice(0, 100),
      });
    }

    if (
      /\.\.\/\.\./.test(line) &&
      !/^(?:import|export)\s/.test(trimmed) &&
      !file.includes(".test.") &&
      !file.includes("test_")
    ) {
      findings.push({
        ruleId: "SEC-PATH-TRAVERSAL",
        severity: "error",
        message:
          "Potential path traversal sequence (../../) in path resolution",
        file,
        line: lineNum,
        snippet: line.slice(0, 100),
      });
    }
  }

  const secretLocations = new Set(
    findings
      .filter((f) =>
        ["SEC-PRIVATE-KEY", "SEC-TOKEN-LEAK", "SEC-HARDCODED-SECRET"].includes(
          f.ruleId,
        ),
      )
      .map((f) => `${f.file ?? ""}:${String(f.line)}`),
  );
  for (const finding of findings) {
    if (secretLocations.has(`${finding.file ?? ""}:${String(finding.line)}`)) {
      finding.snippet = "[REDACTED]";
    }
  }
  const hasCritical = findings.some((f) => f.severity === "critical");
  const hasError = findings.some((f) => f.severity === "error");
  const passed = !hasCritical && !hasError;
  const score = passed
    ? findings.length === 0
      ? 100
      : 85
    : Math.max(0, 100 - findings.length * 35);

  return {
    agent,
    role: "security",
    decision: passed ? "approved" : "rejected",
    passed,
    score,
    findings,
    summary: passed
      ? findings.length === 0
        ? "Security evaluation passed: no security vulnerabilities detected"
        : `Security evaluation passed with ${String(findings.length)} warning(s)`
      : `Security evaluation REJECTED: ${String(findings.length)} security violation(s) detected (${findings.map((f) => f.ruleId).join(", ")})`,
    timestamp: new Date().toISOString(),
  };
}

export function evaluateLintReview(
  input: ReviewInput,
  agent = "lint-agent",
): ReviewEvaluation {
  const lines = extractLinesFromReviewInput(input);
  const findings: ReviewFinding[] = [];

  for (const { file, lineNum, line } of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("//") || trimmed.startsWith("#")) {
      if (/(?:TODO|FIXME)\s*:\s*(?:BLOCKER|CRITICAL|SECURITY)/i.test(trimmed)) {
        findings.push({
          ruleId: "LINT-BLOCKER-COMMENT",
          severity: "error",
          message: "Unresolved blocker or security TODO comment left in code",
          file,
          line: lineNum,
          snippet: line.slice(0, 100),
        });
      }
      continue;
    }

    if (/\bdebugger\b/.test(line)) {
      findings.push({
        ruleId: "LINT-DEBUGGER",
        severity: "error",
        message: "Debugger statement found in code",
        file,
        line: lineNum,
        snippet: line.slice(0, 100),
      });
    }

    if (/\b(?:pdb\.set_trace|breakpoint)\s*\(/.test(line)) {
      findings.push({
        ruleId: "LINT-BREAKPOINT",
        severity: "error",
        message: "Python breakpoint statement found in code",
        file,
        line: lineNum,
        snippet: line.slice(0, 100),
      });
    }

    if (
      /\bconsole\.log\s*\(/.test(line) &&
      !file.includes(".test.") &&
      !file.includes("test_") &&
      !file.includes("cli")
    ) {
      findings.push({
        ruleId: "LINT-CONSOLE-LOG",
        severity: "warning",
        message: "console.log left in production code",
        file,
        line: lineNum,
        snippet: line.slice(0, 100),
      });
    }
  }

  const hasError = findings.some(
    (f) => f.severity === "error" || f.severity === "critical",
  );
  const passed = !hasError;
  const score = passed
    ? findings.length === 0
      ? 100
      : 90
    : Math.max(0, 100 - findings.length * 30);

  return {
    agent,
    role: "lint",
    decision: passed ? "approved" : "rejected",
    passed,
    score,
    findings,
    summary: passed
      ? findings.length === 0
        ? "Linting evaluation passed: clean code hygiene"
        : `Linting evaluation passed with ${String(findings.length)} warning(s)`
      : `Linting evaluation REJECTED: ${String(findings.length)} lint violation(s) detected (${findings.map((f) => f.ruleId).join(", ")})`,
    timestamp: new Date().toISOString(),
  };
}

function reviewFailure(
  agent: string,
  role: ReviewRole,
  message: string,
): ReviewEvaluation {
  return {
    agent,
    role,
    decision: "rejected",
    passed: false,
    findings: [{ ruleId: "REVIEW-ERROR", severity: "critical", message }],
    summary: message,
    timestamp: new Date().toISOString(),
  };
}

export async function dispatchParallelReviews(
  input: ReviewInput,
  options: {
    securityAgent?: string;
    lintAgent?: string;
    customEvaluators?: Array<
      (signal: AbortSignal) => ReviewEvaluation | Promise<ReviewEvaluation>
    >;
    timeoutMs?: number;
  } = {},
): Promise<ReviewEvaluation[]> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  if (
    !Number.isFinite(timeoutMs) ||
    timeoutMs <= 0 ||
    timeoutMs > 2_147_483_647
  ) {
    throw new TypeError(
      "Review timeout must be positive, finite and supported by timers",
    );
  }
  const securityAgent = options.securityAgent ?? "security-agent";
  const lintAgent = options.lintAgent ?? "lint-agent";
  const tasks: Array<{
    agent: string;
    role: ReviewRole;
    run: (signal: AbortSignal) => ReviewEvaluation | Promise<ReviewEvaluation>;
  }> = [
    {
      agent: securityAgent,
      role: "security",
      run: () => evaluateSecurityReview(input, securityAgent),
    },
    {
      agent: lintAgent,
      role: "lint",
      run: () => evaluateLintReview(input, lintAgent),
    },
    ...(options.customEvaluators ?? []).map((run, i) => ({
      agent: `custom-${String(i)}`,
      role: "general" as const,
      run,
    })),
  ];
  if (tasks.length > 8)
    throw new TypeError("At most eight review evaluators are supported");

  // Start all callbacks before awaiting any of them; preserve dispatch order.
  return Promise.all(
    tasks.map(
      ({ agent, role, run }) =>
        new Promise<ReviewEvaluation>((resolve) => {
          const controller = new AbortController();
          const timer = setTimeout(() => {
            resolve(reviewFailure(agent, role, "Review evaluation timed out"));
            controller.abort();
          }, timeoutMs);
          void Promise.resolve()
            .then(() => run(controller.signal))
            .then((value) => {
              const parsed = ReviewEvaluationSchema.safeParse(value);
              resolve(
                parsed.success &&
                  (role === "general" || parsed.data.role === role)
                  ? parsed.data
                  : reviewFailure(agent, role, "Malformed review evaluation"),
              );
            })
            .catch(() => {
              resolve(
                reviewFailure(
                  agent,
                  role,
                  "Review evaluator raised an exception",
                ),
              );
            })
            .finally(() => {
              clearTimeout(timer);
            });
        }),
    ),
  );
}

export function evaluateConsensusReviewGate(
  evaluations: ReviewEvaluation[],
  policyInput?: Partial<ConsensusPolicy>,
): ConsensusReviewGateResult {
  const policy = ConsensusPolicySchema.parse(policyInput ?? {});
  const violations: string[] = [];
  evaluations = evaluations.map((value, i) => {
    const parsed = ReviewEvaluationSchema.safeParse(value);
    return parsed.success
      ? parsed.data
      : reviewFailure(
          `invalid-${String(i)}`,
          "general",
          "Malformed review evaluation",
        );
  });
  const identities = evaluations.map((e) => e.agent.trim().toLowerCase());
  if (new Set(identities).size !== identities.length) {
    violations.push("Review agents must have distinct identities");
  }
  if (
    evaluations.some((e) => e.findings.some((f) => f.ruleId === "REVIEW-ERROR"))
  ) {
    violations.push("Review evaluator failed or returned invalid evidence");
  }

  const approvalCount = evaluations.filter(
    (e) => e.passed && e.decision === "approved",
  ).length;
  const rejectionCount = evaluations.filter(
    (e) => !e.passed || e.decision !== "approved",
  ).length;
  const totalEvaluations = evaluations.length;

  const evaluatedRoles = new Set(evaluations.map((e) => e.role));
  for (const requiredRole of policy.requiredRoles) {
    if (!evaluatedRoles.has(requiredRole)) {
      violations.push(
        `Missing required review evaluation for role: '${requiredRole}'`,
      );
    } else if (
      !evaluations
        .filter((e) => e.role === requiredRole)
        .every((e) => e.passed && e.decision === "approved")
    ) {
      violations.push(`Required review role rejected: '${requiredRole}'`);
    }
  }

  let securityGatePassed = true;
  const securityEvals = evaluations.filter((e) => e.role === "security");
  if (policy.requireSecurityApproval) {
    if (securityEvals.length === 0) {
      securityGatePassed = false;
      violations.push(
        "Security policy violated: no security evaluation provided",
      );
    } else if (
      !securityEvals.every((e) => e.passed && e.decision === "approved")
    ) {
      securityGatePassed = false;
      violations.push(
        "Security policy violated: security evaluation rejected or failed",
      );
    }
  }
  if (policy.blockOnCriticalSeverity) {
    const hasCritical = evaluations.some((e) =>
      e.findings.some((f) => f.severity === "critical"),
    );
    if (hasCritical) {
      securityGatePassed = false;
      violations.push(
        "Security policy violated: critical security finding detected",
      );
    }
  }

  let lintGatePassed = true;
  const lintEvals = evaluations.filter((e) => e.role === "lint");
  if (policy.requireLintApproval) {
    if (lintEvals.length === 0) {
      lintGatePassed = false;
      violations.push("Lint policy violated: no lint evaluation provided");
    } else if (!lintEvals.every((e) => e.passed && e.decision === "approved")) {
      lintGatePassed = false;
      violations.push(
        "Lint policy violated: lint evaluation rejected or failed",
      );
    }
  }
  if (policy.blockOnErrorSeverity) {
    const hasLintErrors = evaluations.some((e) =>
      e.findings.some(
        (f) => f.severity === "error" || f.severity === "critical",
      ),
    );
    if (hasLintErrors) {
      lintGatePassed = false;
      violations.push("Lint policy violated: error severity findings detected");
    }
  }

  if (approvalCount < policy.minApprovals) {
    violations.push(
      `Consensus threshold not met: received ${String(approvalCount)} approval(s), expected at least ${String(policy.minApprovals)}`,
    );
  }
  const ratio = totalEvaluations > 0 ? approvalCount / totalEvaluations : 0;
  if (ratio < policy.approvalThreshold) {
    violations.push(
      `Consensus approval ratio not met: ${(ratio * 100).toFixed(1)}% < ${(policy.approvalThreshold * 100).toFixed(1)}%`,
    );
  }

  const consensusReached =
    approvalCount >= policy.minApprovals &&
    ratio >= policy.approvalThreshold &&
    violations.every((v) => !v.startsWith("Consensus"));

  const passed =
    consensusReached &&
    securityGatePassed &&
    lintGatePassed &&
    violations.length === 0;

  const summary = passed
    ? `Consensus review gate PASSED (${String(approvalCount)}/${String(totalEvaluations)} approvals, security gate passed, lint gate passed)`
    : `Consensus review gate FAILED: ${violations.join("; ")}`;

  return {
    passed,
    consensusReached,
    securityGatePassed,
    lintGatePassed,
    approvalCount,
    rejectionCount,
    totalEvaluations,
    policyViolations: violations,
    evaluations,
    summary,
    evaluatedAt: new Date().toISOString(),
  };
}
