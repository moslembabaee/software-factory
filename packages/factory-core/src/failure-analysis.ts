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

export const CorrelationTypeSchema = z.enum([
  "direct_line_match",
  "hunk_match",
  "file_match",
  "test_to_source_match",
]);

export const CorrelationConfidenceSchema = z.enum([
  "high",
  "medium",
  "low",
  "none",
]);

export const CorrelatedLocationSchema = z.strictObject({
  file: z.string(),
  line: z.number().int().optional().nullable(),
  column: z.number().int().optional().nullable(),
  symbol: z.string().optional().nullable(),
  message: z.string(),
  category: DiagnosticCategorySchema,
  correlation_type: CorrelationTypeSchema,
  diff_snippet: z.string().optional().nullable(),
});

export const FailureDiffCorrelationSchema = z.strictObject({
  diff_files: z.array(z.string()),
  correlated_files: z.array(z.string()),
  uncorrelated_files: z.array(z.string()),
  correlated_locations: z.array(CorrelatedLocationSchema),
  confidence: CorrelationConfidenceSchema,
  summary: z.string(),
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
  diff_correlation: FailureDiffCorrelationSchema.optional().nullable(),
});

export const RemediationContextSchema = z.strictObject({
  failure_analysis: FailureAnalysisSchema.optional(),
  diff_correlation: FailureDiffCorrelationSchema.optional(),
  correlated_files: z.array(z.string()).optional(),
  summary: z.string().optional(),
});

export const LocalizedRemediationTaskSchema = z.strictObject({
  id: z.string().min(1),
  parent_task_id: z.string().min(1),
  title: z.string().min(1),
  description: z.string(),
  phase: z.string(),
  status: z.enum([
    "pending",
    "approved",
    "in_progress",
    "waiting_approval",
    "completed",
    "failed",
  ]),
  assigned_agent: z.string(),
  verification_cmd: z.string(),
  target_branch: z.string().optional(),
  branch: z.string().optional(),
  base_branch: z.string().optional(),
  is_bugfix: z.literal(true),
  is_remediation: z.literal(true).optional(),
  retry_count: z.number().int().nonnegative(),
  remediation_context: RemediationContextSchema.optional(),
  created_at: z.string(),
  tenant_id: z.string().optional(),
  project_id: z.string().optional(),
  github_issue_number: z.number().int().positive().nullable().optional(),
});

export type DiagnosticCategory = z.infer<typeof DiagnosticCategorySchema>;
export type FailureDiagnostic = z.infer<typeof FailureDiagnosticSchema>;
export type CorrelationType = z.infer<typeof CorrelationTypeSchema>;
export type CorrelationConfidence = z.infer<typeof CorrelationConfidenceSchema>;
export type CorrelatedLocation = z.infer<typeof CorrelatedLocationSchema>;
export type FailureDiffCorrelation = z.infer<typeof FailureDiffCorrelationSchema>;
export type FailureAnalysis = z.infer<typeof FailureAnalysisSchema>;
export type RemediationContext = z.infer<typeof RemediationContextSchema>;
export type LocalizedRemediationTask = z.infer<typeof LocalizedRemediationTaskSchema>;

export interface DiffHunk {
  startLine: number;
  lineCount: number;
  lines: Array<{ lineNum: number; content: string }>;
}

export interface DiffMetadata {
  files: string[];
  hunksByFile: Record<string, DiffHunk[]>;
  modifiedLinesByFile: Record<string, number[]>;
  addedLinesByFile: Record<string, Array<{ lineNum: number; content: string }>>;
}

export function extractDiffMetadata(diff: string): DiffMetadata {
  const files: string[] = [];
  const hunksByFile: Record<string, DiffHunk[]> = {};
  const modifiedLinesByFile: Record<string, number[]> = {};
  const addedLinesByFile: Record<string, Array<{ lineNum: number; content: string }>> = {};

  let currentFile: string | null = null;
  let currentHunk: DiffHunk | null = null;
  let currentLine = 1;

  for (const rawLine of diff.split("\n")) {
    const gitFileMatch = /^diff --git a\/(.+?) b\/(.+?)$/.exec(rawLine);
    if (gitFileMatch?.[2]) {
      currentFile = gitFileMatch[2].trim();
      if (!files.includes(currentFile)) files.push(currentFile);
      if (!hunksByFile[currentFile]) hunksByFile[currentFile] = [];
      if (!modifiedLinesByFile[currentFile]) modifiedLinesByFile[currentFile] = [];
      if (!addedLinesByFile[currentFile]) addedLinesByFile[currentFile] = [];
      currentHunk = null;
      continue;
    }

    if (rawLine.startsWith("+++ b/")) {
      const file = rawLine.slice(6).trim();
      if (file && file !== "/dev/null") {
        currentFile = file;
        if (!files.includes(currentFile)) files.push(currentFile);
        if (!hunksByFile[currentFile]) hunksByFile[currentFile] = [];
        if (!modifiedLinesByFile[currentFile]) modifiedLinesByFile[currentFile] = [];
        if (!addedLinesByFile[currentFile]) addedLinesByFile[currentFile] = [];
      }
      currentHunk = null;
      continue;
    }

    const hunkMatch = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(rawLine);
    if (hunkMatch?.[1]) {
      currentLine = parseInt(hunkMatch[1], 10);
      const count = hunkMatch[2] ? parseInt(hunkMatch[2], 10) : 1;
      currentHunk = {
        startLine: currentLine,
        lineCount: count,
        lines: [],
      };
      if (currentFile) {
        hunksByFile[currentFile]?.push(currentHunk);
      }
      continue;
    }

    if (!currentFile) continue;

    if (rawLine.startsWith("-") && !rawLine.startsWith("---")) {
      // Deleted line from old file; does not advance new file line counter
      continue;
    }

    if (rawLine.startsWith("+") && !rawLine.startsWith("+++")) {
      const content = rawLine.slice(1);
      modifiedLinesByFile[currentFile]?.push(currentLine);
      addedLinesByFile[currentFile]?.push({ lineNum: currentLine, content });
      currentHunk?.lines.push({ lineNum: currentLine, content });
      currentLine++;
    } else if (rawLine.startsWith(" ")) {
      currentLine++;
    }
  }

  return {
    files,
    hunksByFile,
    modifiedLinesByFile,
    addedLinesByFile,
  };
}

export function correlateFailureWithDiff(
  analysis: FailureAnalysis,
  diff: string,
): FailureDiffCorrelation {
  const meta = extractDiffMetadata(diff);
  const diffFiles = meta.files;
  const correlatedFilesSet = new Set<string>();
  const uncorrelatedFilesSet = new Set<string>();
  const locations: CorrelatedLocation[] = [];

  const normalize = (f: string) => f.replace(/^\.\//, "").trim();
  const normalizedDiffFiles = new Map<string, string>();
  for (const df of diffFiles) {
    normalizedDiffFiles.set(normalize(df), df);
  }

  const findMatchingDiffFile = (filePath: string): string | null => {
    const norm = normalize(filePath);
    if (normalizedDiffFiles.has(norm)) return normalizedDiffFiles.get(norm)!;
    for (const [dfNorm, dfOriginal] of normalizedDiffFiles.entries()) {
      if (norm.endsWith(dfNorm) || dfNorm.endsWith(norm)) {
        return dfOriginal;
      }
    }
    return null;
  };

  for (const file of analysis.implicated_files) {
    const matched = findMatchingDiffFile(file);
    if (matched) {
      correlatedFilesSet.add(matched);
    } else {
      uncorrelatedFilesSet.add(normalize(file));
    }
  }

  for (const diag of analysis.parsed_diagnostics) {
    if (!diag.file) continue;
    const matchedFile = findMatchingDiffFile(diag.file);
    if (!matchedFile) continue;

    correlatedFilesSet.add(matchedFile);
    const line = diag.line ?? null;
    const modifiedLines = meta.modifiedLinesByFile[matchedFile] ?? [];
    const hunks = meta.hunksByFile[matchedFile] ?? [];

    let correlationType: CorrelationType = "file_match";
    let diffSnippet: string | null = null;

    if (line !== null) {
      if (modifiedLines.includes(line)) {
        correlationType = "direct_line_match";
        const added = meta.addedLinesByFile[matchedFile]?.find((a) => a.lineNum === line);
        diffSnippet = added?.content ?? null;
      } else {
        const inHunk = hunks.find(
          (h) => line >= h.startLine - 2 && line <= h.startLine + h.lineCount + 2,
        );
        if (inHunk) {
          correlationType = "hunk_match";
          diffSnippet = inHunk.lines[0]?.content ?? null;
        }
      }
    }

    locations.push({
      file: matchedFile,
      line,
      column: diag.column ?? null,
      symbol: diag.symbol ?? null,
      message: diag.message,
      category: diag.category,
      correlation_type: correlationType,
      diff_snippet: diffSnippet,
    });
  }

  for (const st of analysis.stack_traces) {
    for (const line of st.split("\n")) {
      const match = /([A-Za-z0-9_./-]+\.(?:tsx?|jsx?|mjs|cjs|py)):(\d+)(?::(\d+))?/.exec(line);
      if (match?.[1] && match[2]) {
        const stFile = match[1];
        const stLine = parseInt(match[2], 10);
        const stCol = match[3] ? parseInt(match[3], 10) : null;
        const matched = findMatchingDiffFile(stFile);
        if (matched) {
          correlatedFilesSet.add(matched);
          const modifiedLines = meta.modifiedLinesByFile[matched] ?? [];
          const directMatch = modifiedLines.includes(stLine);
          if (!locations.some((l) => l.file === matched && l.line === stLine)) {
            locations.push({
              file: matched,
              line: stLine,
              column: stCol,
              symbol: null,
              message: `Stack frame at line ${stLine}`,
              category: "runtime_error",
              correlation_type: directMatch ? "direct_line_match" : "file_match",
              diff_snippet: null,
            });
          }
        }
      }
    }
  }

  const correlatedFiles = Array.from(correlatedFilesSet);
  const uncorrelatedFiles = Array.from(uncorrelatedFilesSet).filter(
    (f) => !correlatedFilesSet.has(f),
  );

  let confidence: CorrelationConfidence = "none";
  if (locations.some((l) => l.correlation_type === "direct_line_match")) {
    confidence = "high";
  } else if (
    locations.some((l) => l.correlation_type === "hunk_match") ||
    correlatedFiles.length > 0
  ) {
    confidence = "medium";
  } else if (diffFiles.length > 0) {
    confidence = "low";
  }

  let summary = "";
  if (confidence === "high") {
    const directLoc = locations.find((l) => l.correlation_type === "direct_line_match");
    summary = `Direct correlation: verification failure in \`${directLoc?.file}:${directLoc?.line}\` matches modified lines in recent diff.`;
  } else if (confidence === "medium") {
    summary = `File-level correlation: failure implicates ${correlatedFiles.length} file(s) modified in recent diff: ${correlatedFiles.map((f) => `\`${f}\``).join(", ")}.`;
  } else if (diffFiles.length > 0) {
    summary = `No direct file overlap between verification diagnostics (${analysis.implicated_files.length} file(s)) and recent diff (${diffFiles.length} file(s)).`;
  } else {
    summary = `No recent diff detected to correlate with verification failure.`;
  }

  return {
    diff_files: diffFiles,
    correlated_files: correlatedFiles,
    uncorrelated_files: uncorrelatedFiles,
    correlated_locations: locations,
    confidence,
    summary,
  };
}

export function generateRemediationTaskId(
  parentTaskId: string,
  existingIds: string[] = [],
): string {
  const base = `${parentTaskId}-REMEDY`;
  if (!existingIds.includes(base)) return base;
  let index = 2;
  while (existingIds.includes(`${base}-${index}`)) {
    index++;
  }
  return `${base}-${index}`;
}

export function synthesizeRemediationTask(params: {
  parentTask: {
    id: string;
    title?: string;
    phase?: string;
    assigned_agent?: string;
    verification_cmd?: string;
    target_branch?: string;
    branch?: string;
    base_branch?: string;
    tenant_id?: string;
    project_id?: string;
    github_issue_number?: number | null;
  };
  analysis: FailureAnalysis;
  diff: string;
  existingIds?: string[];
}): LocalizedRemediationTask {
  const { parentTask, analysis, diff, existingIds = [] } = params;
  const taskId = generateRemediationTaskId(parentTask.id, existingIds);
  const correlation = correlateFailureWithDiff(analysis, diff);

  const lines = [
    "### 🤖 Autonomous Verification Remediation Task",
    "",
    `Remediate local verification failure in \`${parentTask.id}\`.`,
    "",
    `- **Parent Task:** \`${parentTask.id}\` — ${parentTask.title ?? ""}`,
    `- **Root Cause Summary:** ${analysis.summary}`,
    `- **Correlation Confidence:** ${correlation.confidence}`,
    "",
    "#### Correlated Diff Impact",
    correlation.summary,
  ];

  if (correlation.correlated_files.length > 0) {
    lines.push(
      `- **Correlated Files:** ${correlation.correlated_files.map((f) => `\`${f}\``).join(", ")}`,
    );
  }
  if (correlation.correlated_locations.length > 0) {
    lines.push("", "#### Correlated Failure Locations");
    for (const loc of correlation.correlated_locations.slice(0, 5)) {
      const sym = loc.symbol ? ` [${loc.symbol}]` : "";
      lines.push(`- \`${loc.file}:${loc.line ?? "?"}\`${sym}: ${loc.message}`);
    }
  }

  lines.push(
    "",
    "#### Diagnostics & Stack Trace",
    "```",
    analysis.raw_tail.slice(-1500),
    "```",
    "",
    "#### Focused Remediation Instructions",
    "Inspect the correlated files and lines modified in the recent diff.",
    "Reproduce the failure using:",
    `\`${parentTask.verification_cmd ?? "npm run typecheck && npm test"}\``,
    "Apply a minimal, localized patch to fix the error while keeping existing tests passing.",
    "Leave Git commits, pushes, and roadmap lifecycle updates to the orchestrator.",
    "",
    `<!-- factory-remediation-for: ${parentTask.id} -->`,
  );

  return {
    ...(parentTask.tenant_id ? { tenant_id: parentTask.tenant_id } : {}),
    ...(parentTask.project_id ? { project_id: parentTask.project_id } : {}),
    id: taskId,
    parent_task_id: parentTask.id,
    title: `Remediation: Fix verification failure in ${parentTask.id}: ${analysis.summary.slice(0, 80)}`,
    description: lines.join("\n"),
    phase: parentTask.phase ?? "Continuous Polish & Evolution",
    status: "approved",
    assigned_agent: parentTask.assigned_agent ?? "claude",
    verification_cmd:
      parentTask.verification_cmd ?? "cd /root/projects/software-factory && npm run typecheck && npm test",
    target_branch: parentTask.target_branch ?? parentTask.branch ?? "main",
    branch: parentTask.branch ?? "main",
    base_branch: parentTask.base_branch ?? "main",
    is_bugfix: true,
    is_remediation: true,
    retry_count: 0,
    remediation_context: {
      failure_analysis: analysis,
      diff_correlation: correlation,
      correlated_files: correlation.correlated_files,
      summary: analysis.summary,
    },
    created_at: new Date().toISOString(),
    ...(parentTask.github_issue_number ? { github_issue_number: parentTask.github_issue_number } : {}),
  };
}
