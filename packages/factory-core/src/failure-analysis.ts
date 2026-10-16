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
  changed_files: z.array(z.string()).max(60).optional(),
  related_files: z.array(z.string()).max(60).optional(),
  diff_excerpt: z.string().max(4000).optional(),
});

export type DiagnosticCategory = z.infer<typeof DiagnosticCategorySchema>;
export type FailureDiagnostic = z.infer<typeof FailureDiagnosticSchema>;
export type FailureAnalysis = z.infer<typeof FailureAnalysisSchema>;
