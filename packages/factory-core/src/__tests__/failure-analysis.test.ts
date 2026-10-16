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
import { FailureAnalysisSchema } from "../index.js";

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
});
