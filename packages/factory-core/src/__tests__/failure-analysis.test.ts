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
  RemediationTaskProposalSchema,
  correlateFailureWithDiff,
  synthesizeRemediationTaskProposal,
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

  it("correlates failure diagnostics with unified diff", () => {
    const analysis = FailureAnalysisSchema.parse({
      exit_code: 1,
      command: "npm test",
      parsed_diagnostics: [],
      failing_tests: ["tests/worker.test.ts"],
      type_errors: [],
      compile_errors: [],
      lint_errors: [],
      assertion_errors: ["Expected true to equal false"],
      runtime_errors: [],
      implicated_files: ["src/worker.ts"],
      stack_traces: [
        "Error: Expected true\n    at Object.<anonymous> (src/worker.ts:25:9)",
      ],
      raw_tail: "Error: failure",
      summary: "Verification FAILED: 1 test failure(s)",
      remediation_hint: "Fix failing test assertions",
      stderr: "Error: failure",
      correlated_files: [],
      correlated_diff: "",
    });

    const diff = [
      "diff --git a/src/worker.ts b/src/worker.ts",
      "index 1234567..89abcdef 100644",
      "--- a/src/worker.ts",
      "+++ b/src/worker.ts",
      "@@ -20,6 +20,10 @@ export function execute() {",
      "+  if (condition) {",
      "+    throw new Error('Expected true');",
      "+  }",
      "diff --git a/src/unrelated.ts b/src/unrelated.ts",
      "index abc..def 100644",
      "--- a/src/unrelated.ts",
      "+++ b/src/unrelated.ts",
      "@@ -1,2 +1,3 @@",
      "+// harmless comment",
    ].join("\n");

    const result = correlateFailureWithDiff(analysis, diff);
    expect(result.correlatedFiles).toEqual(["src/worker.ts"]);
    expect(result.correlatedDiff).toContain("src/worker.ts");
    expect(result.correlatedDiff).not.toContain("src/unrelated.ts");
    expect(result.summary).toContain("src/worker.ts");

    const proposal = synthesizeRemediationTaskProposal(
      {
        id: "T-001",
        title: "Build worker pipeline",
        phase: "Phase 3: Agent Runtime",
        assigned_agent: "claude",
        verification_cmd: "npm test",
      },
      {
        ...analysis,
        correlated_files: result.correlatedFiles,
        correlated_diff: result.correlatedDiff,
      },
    );

    expect(proposal.id).toBe("T-001-PATCH");
    expect(proposal.parent_task_id).toBe("T-001");
    expect(proposal.is_remediation).toBe(true);
    expect(proposal.is_bugfix).toBe(true);
    expect(proposal.description).toContain("src/worker.ts");
    expect(proposal.description).toContain("Autonomous Localized Patch Synthesis");
    expect(proposal.remediation_context.correlated_files).toEqual(["src/worker.ts"]);
    expect(RemediationTaskProposalSchema.parse(proposal)).toBeDefined();
  });
});
