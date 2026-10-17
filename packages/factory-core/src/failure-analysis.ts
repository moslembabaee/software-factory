import { z } from "zod";

export const DiagnosticCategorySchema = z.enum([
  "test_failure",
  "type_error",
  "compile_error",
  "lint_error",
  "assertion_error",
  "runtime_error",
  "timeout",
  "unknown",
]);

export const FailureDiagnosticSchema = z.strictObject({
  category: DiagnosticCategorySchema,
  message: z.string(),
  file: z.string().optional().nullable(),
  line: z.number().int().optional().nullable(),
  column: z.number().int().optional().nullable(),
  symbol: z.string().optional().nullable(),
});

export const ConfidenceLevelSchema = z.enum(["high", "medium", "low"]);

export const DiffFileStatusSchema = z.enum([
  "modified",
  "added",
  "deleted",
  "untracked",
  "unknown",
]);

export const CorrelatedFileSchema = z.strictObject({
  file: z.string(),
  status: DiffFileStatusSchema.default("modified"),
  implicated: z.boolean().default(true),
  error_types: z.array(z.string()).default([]),
  error_lines: z.array(z.number().int()).default([]),
  confidence: ConfidenceLevelSchema.default("medium"),
  relevance: z.string().default(""),
});

export const FailureAnalysisSchema = z.strictObject({
  exit_code: z.number().int(),
  command: z.string().optional().nullable(),
  parsed_diagnostics: z.array(FailureDiagnosticSchema),
  failing_tests: z.array(z.string()),
  type_errors: z.array(z.string()),
  compile_errors: z.array(z.string()),
  lint_errors: z.array(z.string()),
  assertion_errors: z.array(z.string()),
  runtime_errors: z.array(z.string()),
  implicated_files: z.array(z.string()),
  stack_traces: z.array(z.string()),
  raw_tail: z.string(),
  summary: z.string(),
  remediation_hint: z.string(),
  stderr: z.string().optional().default(""),
  correlated_files: z.array(CorrelatedFileSchema).optional().default([]),
  diff_summary: z.string().optional().default(""),
});

export const LocalizedRemediationTaskSchema = z.strictObject({
  id: z.string().min(1),
  parent_task_id: z.string().min(1),
  title: z.string(),
  description: z.string(),
  phase: z.string(),
  status: z
    .enum([
      "approved",
      "in_progress",
      "ready_for_verification",
      "verified",
      "completed",
      "failed",
      "cancelled",
    ])
    .default("approved"),
  assigned_agent: z.string(),
  verification_cmd: z.string(),
  implicated_files: z.array(z.string()).default([]),
  correlated_files: z.array(CorrelatedFileSchema).default([]),
  created_at: z.string().optional(),
  is_remediation: z.boolean().default(true),
  tenant_id: z.string().uuid().nullable().optional(),
  project_id: z.string().uuid().nullable().optional(),
  github_issue_number: z.number().int().positive().nullable().optional(),
});

export type DiagnosticCategory = z.infer<typeof DiagnosticCategorySchema>;
export type FailureDiagnostic = z.infer<typeof FailureDiagnosticSchema>;
export type ConfidenceLevel = z.infer<typeof ConfidenceLevelSchema>;
export type DiffFileStatus = z.infer<typeof DiffFileStatusSchema>;
export type CorrelatedFile = z.infer<typeof CorrelatedFileSchema>;
export type FailureAnalysis = z.infer<typeof FailureAnalysisSchema>;
export type LocalizedRemediationTask = z.infer<
  typeof LocalizedRemediationTaskSchema
>;

export interface DiffFileInfo {
  path: string;
  status?: DiffFileStatus;
  added_lines?: number[];
  modified_lines?: number[];
}

export function correlateFailureWithDiff(
  analysis: FailureAnalysis,
  diffFiles: Array<string | DiffFileInfo>,
): CorrelatedFile[] {
  const normalizedDiffFiles: DiffFileInfo[] = diffFiles.map((item) => {
    if (typeof item === "string") {
      return { path: item.trim(), status: "modified" };
    }
    return item;
  });

  const correlated: CorrelatedFile[] = [];
  const diffFilePaths = new Set(normalizedDiffFiles.map((d) => d.path));

  for (const diffItem of normalizedDiffFiles) {
    const filePath = diffItem.path;
    const errorTypes: string[] = [];
    const errorLines: number[] = [];
    let confidence: ConfidenceLevel = "low";
    let relevance = "Modified in recent diff";
    let isImplicated = false;

    // Check parsed diagnostics for file and line matches
    for (const diag of analysis.parsed_diagnostics) {
      if (
        diag.file &&
        (diag.file === filePath ||
          filePath.endsWith(diag.file) ||
          diag.file.endsWith(filePath))
      ) {
        isImplicated = true;
        if (!errorTypes.includes(diag.category)) {
          errorTypes.push(diag.category);
        }
        if (diag.line !== null && diag.line !== undefined) {
          if (!errorLines.includes(diag.line)) {
            errorLines.push(diag.line);
          }
          const isLineInDiff =
            diffItem.added_lines?.includes(diag.line) ||
            diffItem.modified_lines?.includes(diag.line);
          if (isLineInDiff) {
            confidence = "high";
            relevance = `Direct line match: ${diag.category} at line ${diag.line}`;
          } else if (confidence !== "high") {
            confidence = "high";
            relevance = `Direct file match: ${diag.category} at line ${diag.line}`;
          }
        } else if (confidence !== "high") {
          confidence = "high";
          relevance = `File referenced in ${diag.category}: ${diag.message.slice(0, 80)}`;
        }
      }
    }

    // Check stack traces
    for (const trace of analysis.stack_traces) {
      if (trace.includes(filePath)) {
        isImplicated = true;
        if (!errorTypes.includes("stack_trace")) {
          errorTypes.push("stack_trace");
        }
        if (confidence !== "high") {
          confidence = "high";
          relevance = "File referenced in stack trace frame";
        }
      }
    }

    // Check failing tests
    for (const testName of analysis.failing_tests) {
      if (testName.includes(filePath)) {
        isImplicated = true;
        if (!errorTypes.includes("test_failure")) {
          errorTypes.push("test_failure");
        }
        confidence = "high";
        relevance = `Direct failing test: ${testName.slice(0, 80)}`;
      } else {
        const base = filePath.replace(/\.(?:tsx?|jsx?|mjs|cjs|py)$/, "");
        if (testName.includes(base)) {
          isImplicated = true;
          if (!errorTypes.includes("test_failure")) {
            errorTypes.push("test_failure");
          }
          if (confidence !== "high") {
            confidence = "medium";
            relevance = `Target of failing test: ${testName.slice(0, 80)}`;
          }
        }
      }
    }

    // Check general implicated files
    if (
      !isImplicated &&
      analysis.implicated_files.some(
        (f) =>
          f === filePath || filePath.endsWith(f) || f.endsWith(filePath),
      )
    ) {
      isImplicated = true;
      errorTypes.push("implicated_file");
      if (confidence === "low") {
        confidence = "medium";
        relevance = "Referenced in failure diagnostics";
      }
    }

    if (isImplicated || diffFilePaths.has(filePath)) {
      correlated.push({
        file: filePath,
        status: diffItem.status ?? "modified",
        implicated: isImplicated,
        error_types: errorTypes,
        error_lines: errorLines,
        confidence,
        relevance,
      });
    }
  }

  // Sort: high confidence first, then medium, then low
  const rank: Record<ConfidenceLevel, number> = { high: 3, medium: 2, low: 1 };
  correlated.sort((a, b) => {
    const diff = rank[b.confidence] - rank[a.confidence];
    if (diff !== 0) return diff;
    return b.error_lines.length - a.error_lines.length;
  });

  return correlated;
}

export function generateRemediationTaskId(
  parentTaskId: string,
  existingIds: string[],
): string {
  const base = `${parentTaskId}-REMEDY`;
  if (!existingIds.includes(base)) {
    return base;
  }
  let index = 2;
  while (existingIds.includes(`${base}-${index}`)) {
    index += 1;
  }
  return `${base}-${index}`;
}

export function synthesizeRemediationTask(
  parentTask: {
    id: string;
    title: string;
    phase?: string;
    assigned_agent?: string;
    verification_cmd?: string;
    tenant_id?: string | null;
    project_id?: string | null;
    github_issue_number?: number | null;
  },
  analysis: FailureAnalysis,
  existingIds: string[],
): LocalizedRemediationTask {
  const remedyId = generateRemediationTaskId(parentTask.id, existingIds);
  const correlated = analysis.correlated_files ?? [];
  const topCorrelated = correlated.filter((c) =>
    ["high", "medium"].includes(c.confidence),
  );

  const implicatedFileNames =
    topCorrelated.length > 0
      ? topCorrelated.map((c) => c.file)
      : analysis.implicated_files.slice(0, 6);

  const lines: string[] = [
    "### 🛠️ Autonomous Localized Remediation Task",
    "",
    `Remediate verification failure for parent task \`${parentTask.id}\`.`,
    "",
    `- **Parent Task:** \`${parentTask.id}\` — ${parentTask.title}`,
    `- **Exit Code:** \`${analysis.exit_code}\``,
    `- **Verification Command:** \`${parentTask.verification_cmd ?? "npm run typecheck && npm test"}\``,
    "",
    "#### Failure Summary",
    analysis.summary,
    "",
  ];

  if (topCorrelated.length > 0) {
    lines.push("#### Correlated Files (Localized Root Cause)");
    for (const c of topCorrelated) {
      const rel = c.relevance ? `: ${c.relevance}` : "";
      lines.push(`- \`${c.file}\` [${c.confidence} confidence]${rel}`);
    }
    lines.push("");
  } else if (implicatedFileNames.length > 0) {
    lines.push("#### Implicated Files to Inspect");
    for (const f of implicatedFileNames) {
      lines.push(`- \`${f}\``);
    }
    lines.push("");
  }

  if (analysis.failing_tests.length > 0) {
    lines.push(
      "#### Failing Tests",
      ...analysis.failing_tests.slice(0, 5).map((t) => `- \`${t}\``),
      "",
    );
  }

  if (analysis.type_errors.length > 0) {
    lines.push(
      "#### TypeScript Type Errors",
      ...analysis.type_errors.slice(0, 5).map((e) => `- ${e}`),
      "",
    );
  }

  if (analysis.stack_traces.length > 0) {
    lines.push(
      "#### Diagnostic Stack Trace",
      "```",
      analysis.stack_traces[0]!.slice(0, 1500),
      "```",
      "",
    );
  }

  lines.push(
    "#### Remediation Instructions",
    analysis.remediation_hint ||
      "Inspect the correlated files, reproduce the failure, and make a focused fix.",
    `Run \`${parentTask.verification_cmd ?? "npm run typecheck && npm test"}\` before finishing.`,
    "Leave Git commits, pushes, and roadmap lifecycle updates to the orchestrator.",
    "",
    `<!-- factory-remediation-for: ${parentTask.id} -->`,
  );

  return {
    id: remedyId,
    parent_task_id: parentTask.id,
    title: `Remediation: Fix verification failure in ${parentTask.id}: ${analysis.summary}`.slice(
      0,
      120,
    ),
    description: lines.join("\n"),
    phase: parentTask.phase ?? "Continuous Polish & Evolution",
    status: "approved",
    assigned_agent: parentTask.assigned_agent ?? "claude",
    verification_cmd:
      parentTask.verification_cmd ?? "npm run typecheck && npm test",
    implicated_files: implicatedFileNames,
    correlated_files: correlated,
    is_remediation: true,
    tenant_id: parentTask.tenant_id ?? null,
    project_id: parentTask.project_id ?? null,
    github_issue_number: parentTask.github_issue_number ?? null,
    created_at: new Date().toISOString(),
  };
}
