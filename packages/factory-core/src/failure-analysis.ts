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
  correlated_files: z.array(z.string()).optional().default([]),
  correlated_diff: z.string().optional().default(""),
});

export const RemediationContextSchema = z.strictObject({
  parent_task_id: z.string().optional(),
  summary: z.string(),
  exit_code: z.number().int().optional().nullable(),
  failing_tests: z.array(z.string()).optional().default([]),
  implicated_files: z.array(z.string()).optional().default([]),
  correlated_files: z.array(z.string()).optional().default([]),
  correlated_diff: z.string().optional().default(""),
  stack_traces: z.array(z.string()).optional().default([]),
  stderr: z.string().optional().default(""),
  remediation_hint: z.string().optional().default(""),
});

export const RemediationTaskProposalSchema = z.strictObject({
  id: z.string(),
  parent_task_id: z.string(),
  title: z.string(),
  description: z.string(),
  phase: z.string(),
  status: z.enum(["pending", "approved", "waiting_approval"]),
  assigned_agent: z.string(),
  verification_cmd: z.string(),
  is_remediation: z.literal(true),
  is_bugfix: z.literal(true),
  retry_count: z.number().int().nonnegative().default(0),
  remediation_context: RemediationContextSchema,
  created_at: z.string(),
});

export type DiagnosticCategory = z.infer<typeof DiagnosticCategorySchema>;
export type FailureDiagnostic = z.infer<typeof FailureDiagnosticSchema>;
export type FailureAnalysis = z.infer<typeof FailureAnalysisSchema>;
export type RemediationContext = z.infer<typeof RemediationContextSchema>;
export type RemediationTaskProposal = z.infer<
  typeof RemediationTaskProposalSchema
>;

export interface CorrelatedDiffResult {
  correlatedFiles: string[];
  correlatedDiff: string;
  summary: string;
}

export function correlateFailureWithDiff(
  analysis: FailureAnalysis,
  diff: string,
): CorrelatedDiffResult {
  if (!diff || !diff.trim()) {
    return {
      correlatedFiles: [],
      correlatedDiff: "",
      summary: "No recent diff available for correlation",
    };
  }

  const implicatedSet = new Set(
    analysis.implicated_files.map((f) => f.trim().replace(/^\.\//, "")),
  );

  // Extract stack trace files
  for (const st of analysis.stack_traces) {
    const fileMatches = st.matchAll(
      /([A-Za-z0-9_./-]+\.(?:tsx?|jsx?|mjs|cjs|py)):(\d+)/g,
    );
    for (const match of fileMatches) {
      if (match[1] && !match[1].includes("node_modules/")) {
        implicatedSet.add(match[1].trim().replace(/^\.\//, ""));
      }
    }
  }

  const correlatedFiles: string[] = [];
  const correlatedHunks: string[] = [];

  // Split diff into per-file chunks
  const fileChunks = diff.split(/^diff --git /m).filter(Boolean);
  for (const chunk of fileChunks) {
    const firstLine = chunk.split("\n", 1)[0] ?? "";
    const match = firstLine.match(/a\/(.+?)\s+b\/(.+?)$/);
    if (!match) continue;
    const targetFile = match[2].trim().replace(/^\.\//, "");

    const isDirectMatch =
      implicatedSet.has(targetFile) ||
      Array.from(implicatedSet).some(
        (imp) => imp.endsWith(targetFile) || targetFile.endsWith(imp),
      );

    if (isDirectMatch) {
      correlatedFiles.push(targetFile);
      correlatedHunks.push(`diff --git ${chunk.trim()}`);
    }
  }

  const correlatedDiff = correlatedHunks.join("\n\n").slice(0, 4000);
  const summary = correlatedFiles.length
    ? `Failure correlates with recent changes in ${correlatedFiles.join(", ")}`
    : "No direct correlation found between failure diagnostics and recent diff";

  return {
    correlatedFiles,
    correlatedDiff,
    summary,
  };
}

export function generateRemediationTaskId(
  parentTaskId: string,
  existingIds: string[] = [],
): string {
  const base = `${parentTaskId}-PATCH`;
  if (!existingIds.includes(base)) {
    return base;
  }
  let index = 2;
  while (existingIds.includes(`${base}-${index}`)) {
    index++;
  }
  return `${base}-${index}`;
}

export function synthesizeRemediationTaskProposal(
  parentTask: {
    id: string;
    title: string;
    phase?: string;
    assigned_agent?: string;
    verification_cmd?: string;
    tenant_id?: string;
    project_id?: string;
  },
  analysis: FailureAnalysis,
  existingIds: string[] = [],
): RemediationTaskProposal {
  const id = generateRemediationTaskId(parentTask.id, existingIds);
  const summaryPreview = analysis.summary.slice(0, 80);
  const title = `Patch: Fix verification failure in ${parentTask.id}: ${summaryPreview}`;
  const verificationCmd =
    parentTask.verification_cmd ?? "npm run typecheck && npm test";

  const descriptionLines = [
    "### 🩹 Autonomous Localized Patch Synthesis",
    "",
    `Remediate verification failure in task \`${parentTask.id}\`.`,
    "",
    `- **Parent Task:** \`${parentTask.id}\` — ${parentTask.title}`,
    `- **Verification Command:** \`${verificationCmd}\``,
    "",
    "#### Failure Diagnostics",
    `- **Exit Code:** ${analysis.exit_code}`,
    `- **Summary:** ${analysis.summary}`,
    "",
  ];

  if (analysis.failing_tests.length > 0) {
    descriptionLines.push(
      "#### Failing Tests",
      ...analysis.failing_tests.map((t) => `- \`${t}\``),
      "",
    );
  }

  if (analysis.stack_traces.length > 0) {
    descriptionLines.push(
      "#### Diagnostic Stack Trace",
      "```",
      analysis.stack_traces[0].slice(0, 1500),
      "```",
      "",
    );
  }

  if (analysis.stderr) {
    descriptionLines.push(
      "#### Stderr Output",
      "```",
      analysis.stderr.slice(0, 1500),
      "```",
      "",
    );
  }

  if (analysis.correlated_files && analysis.correlated_files.length > 0) {
    descriptionLines.push(
      "#### Correlated Diff Analysis",
      "Recent changes in the following files correlate with the failure:",
      ...analysis.correlated_files.map((f) => `- \`${f}\``),
      "",
    );
    if (analysis.correlated_diff) {
      descriptionLines.push(
        "```diff",
        analysis.correlated_diff.slice(0, 2500),
        "```",
        "",
      );
    }
  }

  descriptionLines.push(
    "#### Localized Remediation Instructions",
    "Inspect the correlated files and failure diagnostics above.",
    "Make a focused patch to resolve the failure while preserving existing behavior.",
    "",
    "#### Quality Gate Verification",
    "```bash",
    verificationCmd,
    "```",
    `<!-- factory-patch-for: ${parentTask.id} -->`,
  );

  return {
    id,
    parent_task_id: parentTask.id,
    title: title.slice(0, 120),
    description: descriptionLines.join("\n"),
    phase: parentTask.phase ?? "Continuous Polish & Evolution",
    status: "approved",
    assigned_agent: parentTask.assigned_agent ?? "claude",
    verification_cmd: verificationCmd,
    is_remediation: true,
    is_bugfix: true,
    retry_count: 0,
    remediation_context: {
      parent_task_id: parentTask.id,
      summary: analysis.summary,
      exit_code: analysis.exit_code,
      failing_tests: analysis.failing_tests,
      implicated_files: analysis.implicated_files,
      correlated_files: analysis.correlated_files ?? [],
      correlated_diff: analysis.correlated_diff ?? "",
      stack_traces: analysis.stack_traces,
      stderr: analysis.stderr ?? "",
      remediation_hint: analysis.remediation_hint,
    },
    created_at: new Date().toISOString(),
  };
}
