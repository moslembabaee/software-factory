import { spawnSync } from "node:child_process";
import {
  closeSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  FailureAnalysisSchema,
  FailureDiffCorrelationSchema,
  LocalizedRemediationTaskSchema,
  extractDiffMetadata,
  correlateFailureWithDiff,
  generateRemediationTaskId,
  synthesizeRemediationTask,
  type FailureAnalysis,
} from "../index.js";

describe("worker reflection contract", () => {
  it("accepts structured diagnostics produced by the Python worker", (context) => {
    const directory = mkdtempSync(join(tmpdir(), "sf-reflection-"));
    context.onTestFinished(() =>
      rmSync(directory, { recursive: true, force: true }),
    );
    const outputPath = join(directory, "analysis.json");
    const output = openSync(outputPath, "w");
    context.onTestFinished(() => closeSync(output));
    const result = spawnSync(
      "python3",
      [
        "-c",
        [
          "import json",
          "from failure_analysis import analyze_failure",
          "print(json.dumps(analyze_failure(2, 'src/worker.ts(4,2): error TS2322: Wrong type', 'npm run typecheck').to_dict()))",
        ].join("\n"),
      ],
      {
        cwd: fileURLToPath(new URL("../../../../", import.meta.url)),
        stdio: ["ignore", output, output],
        timeout: 5000,
      },
    );
    expect(result.error).toBeUndefined();
    const captured = readFileSync(outputPath, "utf8");
    expect(result.status, captured).toBe(0);
    const analysis = FailureAnalysisSchema.parse(JSON.parse(captured));
    expect(analysis.command).toBe("npm run typecheck");
    expect(analysis.parsed_diagnostics[0]).toEqual({
      category: "type_error",
      message: "Wrong type",
      file: "src/worker.ts",
      line: 4,
      column: 2,
      symbol: "TS2322",
    });
    expect(analysis.summary).toContain("TS2322");
    expect(
      FailureAnalysisSchema.safeParse({
        ...analysis,
        parsed_diagnostics: [{ category: "unsupported", message: "bad" }],
      }).success,
    ).toBe(false);
  });

  it("extracts diff metadata and parses modified lines and hunks", () => {
    const sampleDiff = `diff --git a/src/service.ts b/src/service.ts
index 123..456 100644
--- a/src/service.ts
+++ b/src/service.ts
@@ -10,3 +10,4 @@ function run() {
   const x = 1;
+  const y: string = 2;
   return x;
 }
diff --git a/src/utils.ts b/src/utils.ts
index 789..012 100644
--- a/src/utils.ts
+++ b/src/utils.ts
@@ -1,2 +1,3 @@
 export function helper() {
+  console.log("debug");
 }`;
    const meta = extractDiffMetadata(sampleDiff);
    expect(meta.files).toEqual(["src/service.ts", "src/utils.ts"]);
    expect(meta.modifiedLinesByFile["src/service.ts"]).toEqual([11]);
    expect(meta.modifiedLinesByFile["src/utils.ts"]).toEqual([2]);
    expect(meta.addedLinesByFile["src/service.ts"]?.[0]?.content).toBe("  const y: string = 2;");
  });

  it("correlates failure diagnostics with recent file diffs (direct line match)", () => {
    const sampleDiff = `diff --git a/src/service.ts b/src/service.ts
--- a/src/service.ts
+++ b/src/service.ts
@@ -10,4 +10,5 @@ export function calculate() {
-  return 42;
+  const bad: number = "string";
+  return 42;
 }`;
    const analysis: FailureAnalysis = {
      exit_code: 2,
      command: "npm run typecheck",
      parsed_diagnostics: [
        {
          category: "type_error",
          message: "Type 'string' is not assignable to type 'number'",
          file: "src/service.ts",
          line: 10,
          column: 9,
          symbol: "TS2322",
        },
      ],
      failing_tests: [],
      type_errors: ["[TS2322] src/service.ts:10:9: Type 'string' is not assignable to type 'number'"],
      compile_errors: [],
      lint_errors: [],
      assertion_errors: [],
      runtime_errors: [],
      implicated_files: ["src/service.ts"],
      stack_traces: [],
      raw_tail: "src/service.ts(10,9): error TS2322: Type 'string' is not assignable to type 'number'",
      summary: "1 TypeScript error(s): TS2322 in src/service.ts",
      remediation_hint: "Resolve all TypeScript compiler errors.",
    };

    const correlation = correlateFailureWithDiff(analysis, sampleDiff);
    expect(FailureDiffCorrelationSchema.safeParse(correlation).success).toBe(true);
    expect(correlation.confidence).toBe("high");
    expect(correlation.correlated_files).toEqual(["src/service.ts"]);
    expect(correlation.correlated_locations).toHaveLength(1);
    expect(correlation.correlated_locations[0]?.correlation_type).toBe("direct_line_match");
    expect(correlation.correlated_locations[0]?.diff_snippet).toBe('  const bad: number = "string";');
    expect(correlation.summary).toContain("Direct correlation");
  });

  it("handles uncorrelated or missing diffs gracefully", () => {
    const analysis: FailureAnalysis = {
      exit_code: 1,
      command: "npm test",
      parsed_diagnostics: [],
      failing_tests: ["auth.test.ts"],
      type_errors: [],
      compile_errors: [],
      lint_errors: [],
      assertion_errors: ["Expected true to be false"],
      runtime_errors: [],
      implicated_files: ["tests/auth.test.ts"],
      stack_traces: [],
      raw_tail: "AssertionError: Expected true to be false",
      summary: "Assertion failed",
      remediation_hint: "Fix test",
    };

    const emptyCorrelation = correlateFailureWithDiff(analysis, "");
    expect(emptyCorrelation.confidence).toBe("none");
    expect(emptyCorrelation.correlated_files).toHaveLength(0);
    expect(emptyCorrelation.summary).toContain("No recent diff detected");

    const unrelatedDiff = `diff --git a/docs/README.md b/docs/README.md
--- a/docs/README.md
+++ b/docs/README.md
@@ -1 +1 @@
-# Old
+# New`;
    const unrelatedCorrelation = correlateFailureWithDiff(analysis, unrelatedDiff);
    expect(unrelatedCorrelation.confidence).toBe("low");
    expect(unrelatedCorrelation.uncorrelated_files).toEqual(["tests/auth.test.ts"]);
    expect(unrelatedCorrelation.diff_files).toEqual(["docs/README.md"]);
  });

  it("synthesizes localized remediation task into valid schema", () => {
    const parentTask = {
      id: "T-CORE-101",
      title: "Add user profile API",
      phase: "Core API",
      assigned_agent: "claude",
      verification_cmd: "npm test",
      branch: "factory/t-core-101",
      tenant_id: "00000000-0000-4000-8000-000000000001",
      project_id: "00000000-0000-4000-8000-000000000002",
      github_issue_number: 101,
    };

    const analysis: FailureAnalysis = {
      exit_code: 1,
      command: "npm test",
      parsed_diagnostics: [
        {
          category: "test_failure",
          message: "user profile rejects empty email",
          file: "src/profile.ts",
          line: 23,
          column: 5,
        },
      ],
      failing_tests: ["user profile rejects empty email"],
      type_errors: [],
      compile_errors: [],
      lint_errors: [],
      assertion_errors: ["Expected 400 to equal 200"],
      runtime_errors: [],
      implicated_files: ["src/profile.ts"],
      stack_traces: ["  at src/profile.ts:23:5"],
      raw_tail: "FAIL src/profile.test.ts\nAssertionError: Expected 400 to equal 200\n  at src/profile.ts:23:5",
      summary: "1 test failure(s): user profile rejects empty email",
      remediation_hint: "Check email validation status code.",
    };

    const diff = `diff --git a/src/profile.ts b/src/profile.ts
--- a/src/profile.ts
+++ b/src/profile.ts
@@ -23,3 +23,4 @@ export function validateProfile(p) {
-  if (!p.email) return 400;
+  if (!p.email) return 200;
   return 0;
 }`;

    const taskId = generateRemediationTaskId(parentTask.id, ["T-CORE-101-REMEDY"]);
    expect(taskId).toBe("T-CORE-101-REMEDY-2");

    const remedy = synthesizeRemediationTask({
      parentTask,
      analysis,
      diff,
      existingIds: ["T-CORE-101-REMEDY"],
    });

    const parsed = LocalizedRemediationTaskSchema.parse(remedy);
    expect(parsed.id).toBe("T-CORE-101-REMEDY-2");
    expect(parsed.parent_task_id).toBe("T-CORE-101");
    expect(parsed.is_bugfix).toBe(true);
    expect(parsed.is_remediation).toBe(true);
    expect(parsed.status).toBe("approved");
    expect(parsed.remediation_context?.correlated_files).toEqual(["src/profile.ts"]);
    expect(parsed.remediation_context?.diff_correlation?.confidence).toBe("high");
    expect(parsed.description).toContain("Autonomous Verification Remediation Task");
    expect(parsed.description).toContain("npm test");
  });
});
