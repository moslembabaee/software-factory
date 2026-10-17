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
  LocalizedRemediationTaskSchema,
  correlateFailureWithDiff,
  generateRemediationTaskId,
  synthesizeRemediationTask,
} from "../index.js";

describe("worker reflection contract", () => {
  it("accepts structured diagnostics produced by the Python worker", (context) => {
    const directory = mkdtempSync(join(tmpdir(), "sf-reflection-"));
    context.onTestFinished(() => {
      rmSync(directory, { recursive: true, force: true });
    });
    const outputPath = join(directory, "analysis.json");
    const output = openSync(outputPath, "w");
    context.onTestFinished(() => {
      closeSync(output);
    });
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

  it("correlates failure diagnostics with modified lines in diff", () => {
    const analysis = FailureAnalysisSchema.parse({
      exit_code: 1,
      command: "npm test",
      parsed_diagnostics: [
        {
          category: "type_error",
          message: "Type mismatch",
          file: "src/engine.ts",
          line: 42,
          column: 5,
          symbol: "TS2322",
        },
      ],
      failing_tests: ["src/engine.test.ts > runs properly"],
      type_errors: ["src/engine.ts:42:5: Type mismatch"],
      compile_errors: [],
      lint_errors: [],
      assertion_errors: [],
      runtime_errors: [],
      implicated_files: ["src/engine.ts", "src/engine.test.ts"],
      stack_traces: ["  at Object.<anonymous> (src/engine.ts:42:5)"],
      raw_tail: "error tail",
      summary: "1 TypeScript error(s)",
      remediation_hint: "Fix type error",
      stderr: "error on stderr",
      correlated_files: [],
      diff_summary: "",
    });

    const diffFiles = [
      {
        path: "src/engine.ts",
        status: "modified" as const,
        modified_lines: [40, 41, 42, 43],
      },
      {
        path: "src/other.ts",
        status: "added" as const,
        added_lines: [1, 2, 3],
      },
    ];

    const correlated = correlateFailureWithDiff(analysis, diffFiles);
    expect(correlated.length).toBeGreaterThanOrEqual(1);
    const top = correlated[0]!;
    expect(top.file).toBe("src/engine.ts");
    expect(top.confidence).toBe("high");
    expect(top.implicated).toBe(true);
    expect(top.error_lines).toContain(42);
    expect(top.relevance).toContain("Direct line match");
  });

  it("synthesizes localized remediation tasks conforming to schema", () => {
    const analysis = FailureAnalysisSchema.parse({
      exit_code: 1,
      command: "npm run typecheck && npm test",
      parsed_diagnostics: [
        {
          category: "type_error",
          message: "Property 'id' is missing",
          file: "packages/core/src/model.ts",
          line: 15,
          column: 3,
          symbol: "TS2741",
        },
      ],
      failing_tests: [],
      type_errors: ["[TS2741] packages/core/src/model.ts:15:3: Property 'id' is missing"],
      compile_errors: [],
      lint_errors: [],
      assertion_errors: [],
      runtime_errors: [],
      implicated_files: ["packages/core/src/model.ts"],
      stack_traces: [],
      raw_tail: "error TS2741: Property 'id' is missing",
      summary: "1 TypeScript error(s): packages/core/src/model.ts:15:3",
      remediation_hint: "Add missing id property to model type definition.",
      stderr: "npm ERR! typecheck failed",
      correlated_files: [
        {
          file: "packages/core/src/model.ts",
          status: "modified",
          implicated: true,
          error_types: ["type_error"],
          error_lines: [15],
          confidence: "high",
          relevance: "Direct line match: type_error at line 15",
        },
      ],
      diff_summary: "- MODIFIED `packages/core/src/model.ts` (lines: [15])",
    });

    const parentTask = {
      id: "T-ISSUE-29",
      title: "Add diagnostics feature",
      phase: "Continuous Polish & Evolution",
      assigned_agent: "claude",
      verification_cmd: "npm run typecheck && npm test",
    };

    const task = synthesizeRemediationTask(parentTask, analysis, ["T-ISSUE-29"]);
    const parsed = LocalizedRemediationTaskSchema.parse(task);

    expect(parsed.id).toBe("T-ISSUE-29-REMEDY");
    expect(parsed.parent_task_id).toBe("T-ISSUE-29");
    expect(parsed.status).toBe("approved");
    expect(parsed.is_remediation).toBe(true);
    expect(parsed.implicated_files).toContain("packages/core/src/model.ts");
    expect(parsed.description).toContain("Autonomous Localized Remediation Task");
    expect(parsed.description).toContain("Property 'id' is missing");
  });

  it("handles remediation task ID collisions deterministically", () => {
    const id1 = generateRemediationTaskId("T-100", []);
    expect(id1).toBe("T-100-REMEDY");

    const id2 = generateRemediationTaskId("T-100", ["T-100-REMEDY"]);
    expect(id2).toBe("T-100-REMEDY-2");

    const id3 = generateRemediationTaskId("T-100", ["T-100-REMEDY", "T-100-REMEDY-2"]);
    expect(id3).toBe("T-100-REMEDY-3");
  });
});
