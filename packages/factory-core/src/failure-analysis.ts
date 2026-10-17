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
});

export type DiagnosticCategory = z.infer<typeof DiagnosticCategorySchema>;
export type FailureDiagnostic = z.infer<typeof FailureDiagnosticSchema>;
export type FailureAnalysis = z.infer<typeof FailureAnalysisSchema>;

const SECRET_PATTERNS =
  /\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|sk-[a-zA-Z0-9]{20,}|AKIA[0-9A-Z]{16}|bearer\s+[a-zA-Z0-9._-]{20,}|(?:-----BEGIN[ A-Z0-9_-]*PRIVATE KEY-----))/gi;

export function anonymizeSecrets(text: string): string {
  return text.replace(SECRET_PATTERNS, "[REDACTED]");
}

export function dedupOrdered(items: string[], maxItems = 30): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of items) {
    const trimmed = item.trim();
    const key = trimmed.slice(0, 300);
    if (key && !seen.has(key)) {
      seen.add(key);
      result.push(trimmed);
      if (result.length >= maxItems) break;
    }
  }
  return result;
}

export function parseFailureDiagnostics(output: string): FailureDiagnostic[] {
  const analysis = analyzeFailure(1, output);
  return analysis.parsed_diagnostics;
}

export function generateFailureSummaryFromData(
  exitCode: number,
  command: string | null | undefined,
  isTimeout: boolean,
  failingTests: string[],
  typeErrors: string[],
  compileErrors: string[],
  assertionErrors: string[],
  runtimeErrors: string[],
): string {
  if (isTimeout) {
    const cmdNote = command ? ` on \`${command}\`` : "";
    return `Verification command timed out (exit code ${String(exitCode)})${cmdNote}`;
  }

  const parts: string[] = [];
  if (failingTests.length > 0) {
    const n = failingTests.length;
    const preview = failingTests.slice(0, 3).join(", ");
    parts.push(
      `${String(n)} test failure(s): ${preview}${n > 3 ? ` (+${String(n - 3)} more)` : ""}`,
    );
  }
  if (typeErrors.length > 0) {
    const n = typeErrors.length;
    const preview = typeErrors[0]?.slice(0, 90) ?? "";
    parts.push(
      `${String(n)} TypeScript error(s): ${preview}${n > 1 ? ` (+${String(n - 1)} more)` : ""}`,
    );
  }
  if (compileErrors.length > 0) {
    const n = compileErrors.length;
    const preview = compileErrors[0]?.slice(0, 90) ?? "";
    parts.push(
      `${String(n)} compile error(s): ${preview}${n > 1 ? ` (+${String(n - 1)} more)` : ""}`,
    );
  }
  if (assertionErrors.length > 0 && failingTests.length === 0) {
    const preview = assertionErrors[0]?.slice(0, 90) ?? "";
    parts.push(`Assertion failed: ${preview}`);
  }
  if (runtimeErrors.length > 0) {
    const preview = runtimeErrors[0]?.slice(0, 90) ?? "";
    parts.push(`Runtime error: ${preview}`);
  }

  if (parts.length === 0) {
    const cmdNote = command ? ` for \`${command}\`` : "";
    return `Verification failed with exit code ${String(exitCode)}${cmdNote}`;
  }

  return `Verification FAILED: ${parts.join("; ")}`;
}

export function generateRemediationHint(
  isTimeout: boolean,
  failingTests: string[],
  typeErrors: string[],
  compileErrors: string[],
  assertionErrors: string[],
  runtimeErrors: string[],
  implicatedFiles: string[],
): string {
  if (isTimeout) {
    return "Command timed out. Optimize test execution or check for deadlocks, infinite loops, or hanging background processes.";
  }

  const hints: string[] = [];
  if (typeErrors.length > 0) {
    hints.push(
      "Resolve all TypeScript compiler errors and ensure strict type compliance.",
    );
  }
  if (compileErrors.length > 0) {
    hints.push(
      "Fix import/syntax/compilation errors preventing test bundle execution.",
    );
  }
  if (assertionErrors.length > 0) {
    hints.push(
      "Inspect failing assertion statements and verify condition predicates.",
    );
  }
  if (failingTests.length > 0) {
    hints.push(
      "Fix failing test assertions: check boundary values, expected output, and mock contracts.",
    );
  }
  if (runtimeErrors.length > 0) {
    hints.push("Address uncaught exceptions and verify error handling.");
  }
  if (implicatedFiles.length > 0) {
    const fileList = implicatedFiles
      .slice(0, 6)
      .map((f) => `\`${f}\``)
      .join(", ");
    hints.push(`Primary files to inspect: ${fileList}.`);
  }
  return hints.length > 0
    ? hints.join(" ")
    : "Review the verification output below and correct the failure.";
}

export class ReflectionEngine {
  constructor(public readonly maxFeedbackChars: number = 4000) {}

  analyze(
    exitCode: number,
    output: string,
    command?: string | null,
  ): FailureAnalysis {
    const cleanOutput = anonymizeSecrets(
      output
        .slice(-64_000)
        .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, ""),
    );
    const lines = cleanOutput.split(/\r?\n/);

    const diagnostics: FailureDiagnostic[] = [];
    const failingTests: string[] = [];
    const typeErrors: string[] = [];
    const compileErrors: string[] = [];
    const lintErrors: string[] = [];
    const assertionErrors: string[] = [];
    const runtimeErrors: string[] = [];
    const implicatedFiles: string[] = [];
    const stackTraces: string[] = [];

    let currentTrace: string[] = [];
    let inPythonTrace = false;

    const isTimeout =
      exitCode === -1 || cleanOutput.includes("Command timed out");

    const flushTrace = (): void => {
      if (currentTrace.length > 0) {
        stackTraces.push(currentTrace.join("\n"));
        currentTrace = [];
        inPythonTrace = false;
      }
    };

    for (const rawLine of lines) {
      const lineSlice = rawLine.slice(0, 1000);
      const line = lineSlice.trim();
      if (!line) {
        flushTrace();
        continue;
      }

      const scrubbed = anonymizeSecrets(line);

      if (scrubbed.includes("Traceback (most recent call last):")) {
        flushTrace();
        currentTrace = [scrubbed];
        inPythonTrace = true;
        continue;
      }

      if (inPythonTrace) {
        currentTrace.push(scrubbed);
        if (
          !rawLine.startsWith(" ") &&
          !rawLine.startsWith("\t") &&
          currentTrace.length > 1
        ) {
          flushTrace();
        } else {
          continue;
        }
      }

      // Node / V8 stack frames
      if (
        /^\s*(?:at\s+|❯\s+[a-zA-Z0-9_./-]+\.(?:tsx?|jsx?|mjs|cjs):\d+:\d+)/.test(
          rawLine,
        )
      ) {
        currentTrace.push(scrubbed);
        const frameFile = /([A-Za-z0-9_./-]+\.(?:tsx?|jsx?|mjs|cjs)):\d+:\d+/.exec(
          scrubbed,
        );
        if (frameFile?.[1] && !frameFile[1].includes("node_modules/")) {
          implicatedFiles.push(frameFile[1]);
        }
        if (currentTrace.length >= 15) {
          flushTrace();
        }
        continue;
      } else if (currentTrace.length > 0 && !inPythonTrace) {
        flushTrace();
      }

      // TypeScript compiler error: file(line,col): error TSxxxx: message
      // or file:line:col - error TSxxxx: message
      const tsMatch =
        /^([a-zA-Z0-9_./-]+\.(?:tsx?|mts|cts|jsx?|mjs|cjs))(?:\((\d+)(?:,(\d+))?\)|:(\d+):(\d+))\s*(?:-\s*|:\s*)error\s+(TS\d+):\s*(.+)/.exec(
          scrubbed,
        );
      if (tsMatch) {
        const filePath = tsMatch[1] ?? "";
        const lineNo = parseInt(tsMatch[2] || tsMatch[4] || "0", 10);
        const colNo = parseInt(tsMatch[3] || tsMatch[5] || "0", 10);
        const code = tsMatch[6] ?? "";
        const msg = tsMatch[7] ?? "";
        diagnostics.push({
          category: "type_error",
          message: msg,
          file: filePath || null,
          line: lineNo || null,
          column: colNo || null,
          symbol: code || null,
        });
        typeErrors.push(
          `[${code}] ${filePath}:${String(lineNo)}:${String(colNo)}: ${msg}`,
        );
        implicatedFiles.push(filePath);
        continue;
      }

      // Bare error TSxxxx: message
      const bareTs = /^error\s+(TS\d+):\s*(.+)/.exec(scrubbed);
      if (bareTs) {
        const code = bareTs[1] ?? "";
        const msg = bareTs[2] ?? "";
        diagnostics.push({
          category: "type_error",
          message: msg,
          symbol: code || null,
        });
        typeErrors.push(`[${code}]: ${msg}`);
        continue;
      }

      // ESLint / linter: file:line:col: [error|warning] message [rule]
      const lintMatch =
        /^([a-zA-Z0-9_./-]+\.(?:tsx?|jsx?|mjs|cjs|py)):(\d+):(\d+):\s*(?:error|warning)?\s*(.+?)(?:\s+\[([a-zA-Z0-9_-]+)\])?$/.exec(
          scrubbed,
        );
      if (lintMatch) {
        const filePath = lintMatch[1] ?? "";
        const lNo = parseInt(lintMatch[2] || "0", 10);
        const cNo = parseInt(lintMatch[3] || "0", 10);
        const msg = lintMatch[4] ?? "";
        const rule = lintMatch[5] ?? null;
        lintErrors.push(
          `${filePath}:${String(lNo)}:${String(cNo)}: ${msg}${rule ? ` [${rule}]` : ""}`,
        );
        implicatedFiles.push(filePath);
        diagnostics.push({
          category: "lint_error",
          message: msg,
          file: filePath,
          line: lNo || null,
          column: cNo || null,
          symbol: rule,
        });
        continue;
      }

      // Vitest / Jest test failure: ✖ <test name> or ✕ <test name> or × <test name>
      const symbolTest = /^\s*(?:✖|✕|×)\s+(.+)/.exec(scrubbed);
      if (symbolTest?.[1]) {
        const tname = symbolTest[1]
          .replace(/\s+\(\d+(?:\.\d+)?m?s\)$/, "")
          .trim();
        if (
          tname &&
          !tname.startsWith("failing tests") &&
          !tname.startsWith("Test Files")
        ) {
          failingTests.push(tname);
          diagnostics.push({ category: "test_failure", message: tname });
        }
        continue;
      }

      // Vitest test suite case: ❯ path/to/file.test.ts > suite > test name
      if (/^\s*❯\s+/.test(scrubbed) && !/:\d+:\d+$/.test(scrubbed)) {
        const testMatch = /^\s*❯\s+(.+)/.exec(scrubbed);
        if (testMatch?.[1]) {
          const tname = testMatch[1].trim();
          if (tname) {
            failingTests.push(tname);
            diagnostics.push({ category: "test_failure", message: tname });
            const parts = tname.split(" > ");
            if (parts[0] && parts[0].includes(".")) {
              implicatedFiles.push(parts[0].trim());
            }
          }
          continue;
        }
      }

      // FAIL <file> or FAILED <file>
      const failFile = /^FAIL(?:ED)?\s+(\S+)(.*)/.exec(scrubbed);
      if (failFile?.[1]) {
        const targetFile = failFile[1].trim();
        const rest = failFile[2]?.trim() ?? "";
        implicatedFiles.push(targetFile);
        if (rest && !rest.startsWith("(")) {
          failingTests.push(`${targetFile}: ${rest}`);
        } else {
          failingTests.push(targetFile);
        }
        diagnostics.push({
          category: "test_failure",
          message: targetFile,
          file: targetFile,
        });
        continue;
      }

      // TAP / node:test: not ok <num> - <test name>
      const tapMatch = /^not ok\s+\d+\s*-?\s*(.*)/.exec(scrubbed);
      if (tapMatch) {
        const tname = tapMatch[1]?.trim() || "unnamed test";
        failingTests.push(tname);
        diagnostics.push({ category: "test_failure", message: tname });
        continue;
      }

      // Python unittest: FAIL: test_name (module.TestClass)
      const pyFail = /^(?:FAIL|ERROR):\s*([a-zA-Z0-9_]+)\s*\((.+)\)/.exec(
        scrubbed,
      );
      if (pyFail?.[1] && pyFail[2]) {
        const tname = `${pyFail[2]}.${pyFail[1]}`;
        failingTests.push(tname);
        diagnostics.push({ category: "test_failure", message: tname });
        continue;
      }

      // Assertion error pattern: AssertionError: ... or Expected: ... to equal ...
      const assertMatch =
        /^(?:E\s+)?(AssertionError(?:\s*\[[^\]]+\])?\s*:\s*.+)/.exec(scrubbed);
      if (assertMatch?.[1]) {
        const amsg = assertMatch[1];
        assertionErrors.push(amsg);
        diagnostics.push({ category: "assertion_error", message: amsg });
        continue;
      }

      const vitestExpect = /^\s*Expected:\s+(.+)/.exec(scrubbed);
      if (vitestExpect?.[1]) {
        const amsg = `Expected: ${vitestExpect[1]}`;
        assertionErrors.push(amsg);
        diagnostics.push({ category: "assertion_error", message: amsg });
        continue;
      }

      // Generic runtime error or exception line
      const errMatch =
        /^(?:E\s+)?((?:Error|[A-Z]\w*(?:Error|Exception|Fault)|Uncaught\s+\w+Error)(?:\s*\[[^\]]+\])?\s*:\s*.+)/.exec(
          scrubbed,
        );
      if (
        errMatch?.[1] &&
        !scrubbed.startsWith("AssertionError") &&
        !scrubbed.startsWith("SyntaxError")
      ) {
        const emsg = errMatch[1];
        runtimeErrors.push(emsg);
        diagnostics.push({ category: "runtime_error", message: emsg });
        continue;
      }

      // Compile/Syntax error markers: SyntaxError: ..., Cannot find module ...
      const syntaxMatch =
        /^(SyntaxError:\s*.+|Cannot find module\s*.+)/.exec(scrubbed);
      if (syntaxMatch?.[1]) {
        const cmsg = syntaxMatch[1];
        compileErrors.push(cmsg);
        diagnostics.push({ category: "compile_error", message: cmsg });
        continue;
      }

      // Implicated files extraction
      for (const match of scrubbed.matchAll(
        /(?:[A-Za-z0-9_.@/-]+\.(?:tsx?|mts|cts|jsx?|mjs|cjs|py|json))(?=[:(\s"']|$)/g,
      )) {
        const path = match[0];
        if (
          !path.includes("node_modules/") &&
          !path.startsWith("/usr/") &&
          !path.startsWith("/tmp/")
        ) {
          const cleanPath = path
            .split("software-factory/")
            .at(-1)
            ?.replace(/^\.?\//, "");
          if (cleanPath) implicatedFiles.push(cleanPath);
        }
      }
    }

    flushTrace();

    const dedupFailingTests = dedupOrdered(failingTests);
    const dedupTypeErrors = dedupOrdered(typeErrors);
    const dedupCompileErrors = dedupOrdered(compileErrors);
    const dedupLintErrors = dedupOrdered(lintErrors);
    const dedupAssertionErrors = dedupOrdered(assertionErrors);
    const dedupRuntimeErrors = dedupOrdered(runtimeErrors);
    const dedupImplicatedFiles = dedupOrdered(implicatedFiles);
    const dedupStackTraces = dedupOrdered(stackTraces, 4);

    if (isTimeout) {
      diagnostics.push({
        category: "timeout",
        message: `Execution timed out (exit ${String(exitCode)})`,
      });
    }

    const summary = generateFailureSummaryFromData(
      exitCode,
      command,
      isTimeout,
      dedupFailingTests,
      dedupTypeErrors,
      dedupCompileErrors,
      dedupAssertionErrors,
      dedupRuntimeErrors,
    );

    const remediationHint = generateRemediationHint(
      isTimeout,
      dedupFailingTests,
      dedupTypeErrors,
      dedupCompileErrors,
      dedupAssertionErrors,
      dedupRuntimeErrors,
      dedupImplicatedFiles,
    );

    return {
      exit_code: exitCode,
      command: command ?? null,
      parsed_diagnostics: diagnostics.slice(0, 60),
      failing_tests: dedupFailingTests,
      type_errors: dedupTypeErrors,
      compile_errors: dedupCompileErrors,
      lint_errors: dedupLintErrors,
      assertion_errors: dedupAssertionErrors,
      runtime_errors: dedupRuntimeErrors,
      implicated_files: dedupImplicatedFiles,
      stack_traces: dedupStackTraces,
      raw_tail: cleanOutput.slice(-4000),
      summary: summary.slice(0, 1200),
      remediation_hint: remediationHint,
    };
  }

  generateSummary(analysis: FailureAnalysis): string {
    return analysis.summary;
  }

  synthesizeRemediation(
    task: { id?: string; assignedAgent?: string; verificationCmd?: string },
    analysis: FailureAnalysis,
    agent?: string,
  ): string {
    const targetAgent = agent || task.assignedAgent || "assigned agent";
    const command =
      task.verificationCmd || analysis.command || "verification command";
    const instructions = [
      `### Self-Healing Remediation Prompt for ${targetAgent}`,
      `Repair task \`${task.id ?? "current-task"}\` using the failure diagnostics below.`,
      analysis.remediation_hint,
      "Inspect the implicated code, reproduce the failure, and make a focused fix. Preserve the quality gates and existing repository patterns.",
      `Run the full verification command \`${command}\` before finishing.`,
      "Leave Git commits, pushes, and roadmap lifecycle updates to the orchestrator.",
      "",
    ].join("\n");

    const parts: string[] = [
      `## Verification Failure Diagnostics (exit code ${String(analysis.exit_code)})`,
    ];
    if (analysis.command) parts.push(`Command: \`${analysis.command}\``);
    parts.push(`Summary: ${analysis.summary}`);

    if (analysis.failing_tests.length > 0) {
      parts.push("\n### Failing Tests:");
      for (const t of analysis.failing_tests.slice(0, 10)) {
        parts.push(`- \`${t}\``);
      }
      if (analysis.failing_tests.length > 10) {
        parts.push(
          `- ... (+${String(analysis.failing_tests.length - 10)} more)`,
        );
      }
    }

    if (analysis.type_errors.length > 0) {
      parts.push("\n### TypeScript Type Errors:");
      for (const e of analysis.type_errors.slice(0, 8)) {
        parts.push(`- ${e}`);
      }
      if (analysis.type_errors.length > 8) {
        parts.push(`- ... (+${String(analysis.type_errors.length - 8)} more)`);
      }
    }

    if (analysis.compile_errors.length > 0) {
      parts.push("\n### Compilation / Parse Errors:");
      for (const e of analysis.compile_errors.slice(0, 6)) {
        parts.push(`- ${e}`);
      }
    }

    if (analysis.assertion_errors.length > 0) {
      parts.push("\n### Assertion Failures:");
      for (const a of analysis.assertion_errors.slice(0, 5)) {
        parts.push(`- ${a}`);
      }
    }

    if (analysis.runtime_errors.length > 0) {
      parts.push("\n### Runtime Exceptions:");
      for (const r of analysis.runtime_errors.slice(0, 5)) {
        parts.push(`- ${r}`);
      }
    }

    if (analysis.lint_errors.length > 0) {
      parts.push("\n### Lint Errors:");
      for (const l of analysis.lint_errors.slice(0, 5)) {
        parts.push(`- ${l}`);
      }
    }

    if (analysis.implicated_files.length > 0) {
      parts.push("\n### Implicated Files to Inspect:");
      for (const f of analysis.implicated_files.slice(0, 12)) {
        parts.push(`- \`${f}\``);
      }
    }

    if (analysis.stack_traces.length > 0) {
      parts.push("\n### Diagnostic Stack Trace:");
      for (const st of analysis.stack_traces.slice(0, 2)) {
        const frameLines = st.split(/\r?\n/).slice(0, 10);
        parts.push(`\`\`\`\n${frameLines.join("\n")}\n\`\`\``);
      }
    }

    if (analysis.remediation_hint) {
      parts.push(`\n### Remediation Suggestion:\n${analysis.remediation_hint}`);
    }

    const details = `${parts.join("\n")}\nRaw diagnostic tail:\n${analysis.raw_tail.slice(-1000)}`;
    const combined = instructions + details;
    return combined.slice(0, this.maxFeedbackChars);
  }

  formatFeedback(
    agent: string,
    failureType: string,
    analysis: FailureAnalysis,
    rawOutput: string,
    task?: { id?: string },
  ): string {
    const remediation = this.synthesizeRemediation(
      task || { id: "task" },
      analysis,
      agent,
    );
    const header = `${agent}: ${failureType}\n`;
    const body = `${remediation}\n\nRaw diagnostic tail:\n${rawOutput.slice(-1500)}`;
    const combined = header + body;
    return combined.slice(0, this.maxFeedbackChars);
  }
}

const defaultEngine = new ReflectionEngine();

export function analyzeFailure(
  exitCode: number,
  output: string,
  command?: string | null,
): FailureAnalysis {
  return defaultEngine.analyze(exitCode, output, command);
}

export function synthesizeRemediationPrompt(
  task: { id?: string; assignedAgent?: string; verificationCmd?: string },
  analysis: FailureAnalysis,
  agent?: string,
): string {
  return defaultEngine.synthesizeRemediation(task, analysis, agent);
}

export function generateFailureSummary(analysis: FailureAnalysis): string {
  return defaultEngine.generateSummary(analysis);
}

export function formatFeedback(
  agent: string,
  failureType: string,
  analysis: FailureAnalysis,
  rawOutput: string,
  task?: { id?: string },
): string {
  return defaultEngine.formatFeedback(
    agent,
    failureType,
    analysis,
    rawOutput,
    task,
  );
}

