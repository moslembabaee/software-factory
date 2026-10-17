"""Automated failure analysis and self-healing reflection engine.

Parses stderr and test-failure diagnostics from verification_cmd output,
generates structured failure summaries, and auto-synthesizes remediation prompts
for the assigned agent before retrying.

This module runs in the trusted repository worker process (orchestrator.py).
Never feed it untrusted tenant input.
"""

from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path
import re
from dataclasses import asdict, dataclass, field
from typing import Callable, Literal

DiagnosticCategory = Literal[
    "test_failure",
    "type_error",
    "compile_error",
    "lint_error",
    "assertion_error",
    "runtime_error",
    "timeout",
    "unknown",
]

ConfidenceLevel = Literal["high", "medium", "low"]
DiffFileStatus = Literal["modified", "added", "deleted", "untracked", "unknown"]


@dataclass
class CorrelatedFile:
    """A file in recent diff correlated with failure diagnostics."""
    file: str
    status: DiffFileStatus = "modified"
    implicated: bool = True
    error_types: list[str] = field(default_factory=list)
    error_lines: list[int] = field(default_factory=list)
    confidence: ConfidenceLevel = "medium"
    relevance: str = ""

    def to_dict(self) -> dict:
        return asdict(self)


@dataclass
class DiffFileInfo:
    """Information about a changed file in the recent diff."""
    path: str
    status: DiffFileStatus = "modified"
    added_lines: list[int] = field(default_factory=list)
    modified_lines: list[int] = field(default_factory=list)

    def to_dict(self) -> dict:
        return asdict(self)

SECRET_PATTERNS = re.compile(
    r"(?i)\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|sk-[a-zA-Z0-9]{20,}|AKIA[0-9A-Z]{16}|bearer\s+[a-zA-Z0-9._-]{20,}|(?:-----BEGIN[ A-Z0-9_-]*PRIVATE KEY-----))",
)


def anonymize_secrets(text: str) -> str:
    """Scrub potential credentials from diagnostics before prompts or storage."""
    return SECRET_PATTERNS.sub("[REDACTED]", text)


def dedup_ordered(items: list[str], max_items: int = 30) -> list[str]:
    seen: set[str] = set()
    result: list[str] = []
    for item in items:
        key = item.strip()[:300]
        if key and key not in seen:
            seen.add(key)
            result.append(item.strip())
            if len(result) >= max_items:
                break
    return result


@dataclass
class FailureDiagnostic:
    """One atomic parsed diagnostic from a verification failure."""
    category: DiagnosticCategory
    message: str
    file: str | None = None
    line: int | None = None
    column: int | None = None
    symbol: str | None = None

    def to_dict(self) -> dict:
        return asdict(self)


@dataclass
class FailureAnalysis:
    """Structured failure analysis generated from verification diagnostics."""
    exit_code: int
    command: str | None = None
    parsed_diagnostics: list[FailureDiagnostic] = field(default_factory=list)
    failing_tests: list[str] = field(default_factory=list)
    type_errors: list[str] = field(default_factory=list)
    compile_errors: list[str] = field(default_factory=list)
    lint_errors: list[str] = field(default_factory=list)
    assertion_errors: list[str] = field(default_factory=list)
    runtime_errors: list[str] = field(default_factory=list)
    implicated_files: list[str] = field(default_factory=list)
    stack_traces: list[str] = field(default_factory=list)
    raw_tail: str = ""
    summary: str = ""
    remediation_hint: str = ""

    def to_dict(self) -> dict:
        data = asdict(self)
        data["parsed_diagnostics"] = [
            d if isinstance(d, dict) else asdict(d) for d in self.parsed_diagnostics
        ]
        return data

    @classmethod
    def from_dict(cls, data: dict) -> FailureAnalysis:
        diagnostics = []
        for d in data.get("parsed_diagnostics", []):
            if isinstance(d, FailureDiagnostic):
                diagnostics.append(d)
            elif isinstance(d, dict):
                diagnostics.append(FailureDiagnostic(
                    category=d.get("category", "unknown"),
                    message=d.get("message", ""),
                    file=d.get("file"),
                    line=d.get("line"),
                    column=d.get("column"),
                    symbol=d.get("symbol"),
                ))
        return cls(
            exit_code=data.get("exit_code", 1),
            command=data.get("command"),
            parsed_diagnostics=diagnostics[:60],
            failing_tests=list(data.get("failing_tests", [])),
            type_errors=list(data.get("type_errors", [])),
            compile_errors=list(data.get("compile_errors", [])),
            lint_errors=list(data.get("lint_errors", [])),
            assertion_errors=list(data.get("assertion_errors", [])),
            runtime_errors=list(data.get("runtime_errors", [])),
            implicated_files=list(data.get("implicated_files", [])),
            stack_traces=list(data.get("stack_traces", [])),
            raw_tail=str(data.get("raw_tail", "")),
            summary=str(data.get("summary", "")),
            remediation_hint=str(data.get("remediation_hint", "")),
        )

    def to_prompt_section(self, max_length: int = 4000) -> str:
        """Render the structured reflection diagnostics as a clean markdown block."""
        parts = [f"## Verification Failure Diagnostics (exit code {self.exit_code})"]
        if self.command:
            parts.append(f"Command: `{self.command}`")
        parts.append(f"Summary: {self.summary}")

        if self.failing_tests:
            parts.append("\n### Failing Tests:")
            for t in self.failing_tests[:10]:
                parts.append(f"- `{t}`")
            if len(self.failing_tests) > 10:
                parts.append(f"- ... (+{len(self.failing_tests) - 10} more)")

        if self.type_errors:
            parts.append("\n### TypeScript Type Errors:")
            for e in self.type_errors[:8]:
                parts.append(f"- {e}")
            if len(self.type_errors) > 8:
                parts.append(f"- ... (+{len(self.type_errors) - 8} more)")

        if self.compile_errors:
            parts.append("\n### Compilation / Parse Errors:")
            for e in self.compile_errors[:6]:
                parts.append(f"- {e}")

        if self.assertion_errors:
            parts.append("\n### Assertion Failures:")
            for a in self.assertion_errors[:5]:
                parts.append(f"- {a}")

        if self.runtime_errors:
            parts.append("\n### Runtime Exceptions:")
            for r in self.runtime_errors[:5]:
                parts.append(f"- {r}")

        if self.lint_errors:
            parts.append("\n### Lint Errors:")
            for l in self.lint_errors[:5]:
                parts.append(f"- {l}")

        if self.implicated_files:
            parts.append("\n### Implicated Files to Inspect:")
            for f in self.implicated_files[:12]:
                parts.append(f"- `{f}`")

        if self.stack_traces:
            parts.append("\n### Diagnostic Stack Trace:")
            for st in self.stack_traces[:2]:
                lines = st.splitlines()[:10]
                parts.append("```\n" + "\n".join(lines) + "\n```")

        if self.remediation_hint:
            parts.append(f"\n### Remediation Suggestion:\n{self.remediation_hint}")

        result = "\n".join(parts)
        if len(result) > max_length:
            return result[:max_length - 20] + "\n... [truncated]"
        return result


class ReflectionEngine:
    """Automated reflection engine for analyzing failures and synthesizing remediation."""

    def __init__(self, max_feedback_chars: int = 4000) -> None:
        self.max_feedback_chars = max_feedback_chars

    def analyze(self, exit_code: int, output: str, command: str | None = None) -> FailureAnalysis:
        """Parse verification output and produce a structured FailureAnalysis."""
        # Clean ANSI escape sequences
        clean_output = anonymize_secrets(re.sub(r"\x1b\[[0-?]*[ -/]*[@-~]", "", output[-64000:]))
        tail = clean_output
        lines = tail.splitlines()

        diagnostics: list[FailureDiagnostic] = []
        failing_tests: list[str] = []
        type_errors: list[str] = []
        compile_errors: list[str] = []
        lint_errors: list[str] = []
        assertion_errors: list[str] = []
        runtime_errors: list[str] = []
        implicated_files: list[str] = []
        stack_traces: list[str] = []

        current_trace: list[str] = []
        in_python_trace = False

        # Pre-check for timeout marker
        is_timeout = exit_code == -1 or "Command timed out" in clean_output

        for raw_line in lines:
            raw_line = raw_line[:1000]
            line = raw_line.strip()
            if not line:
                if current_trace:
                    stack_traces.append("\n".join(current_trace))
                    current_trace = []
                    in_python_trace = False
                continue

            scrubbed = anonymize_secrets(line)

            # Stack trace handling
            if "Traceback (most recent call last):" in scrubbed:
                if current_trace:
                    stack_traces.append("\n".join(current_trace))
                current_trace = [scrubbed]
                in_python_trace = True
                continue

            if in_python_trace:
                current_trace.append(scrubbed)
                # Python trace ends when a non-indented exception line appears
                if not raw_line.startswith((" ", "\t")) and len(current_trace) > 1:
                    stack_traces.append("\n".join(current_trace))
                    current_trace = []
                    in_python_trace = False
                else:
                    continue

            # Node / V8 stack frames
            if re.match(r"^\s+(?:at\s+|❯\s+[a-zA-Z0-9_./-]+\.(?:tsx?|jsx?|mjs|cjs):\d+:\d+)", raw_line):
                current_trace.append(scrubbed)
                frame_file = re.search(r"([A-Za-z0-9_./-]+\.(?:tsx?|jsx?|mjs|cjs)):\d+:\d+", scrubbed)
                if frame_file and "node_modules/" not in frame_file[1]:
                    implicated_files.append(frame_file[1])
                if len(current_trace) >= 15:
                    stack_traces.append("\n".join(current_trace))
                    current_trace = []
                continue
            elif current_trace and not in_python_trace:
                stack_traces.append("\n".join(current_trace))
                current_trace = []

            # TypeScript compiler error pattern 1: file(line,col): error TSxxxx: message
            # TypeScript compiler error pattern 2: file:line:col - error TSxxxx: message
            ts_match = re.match(
                r"^([a-zA-Z0-9_./-]+\.(?:tsx?|mts|cts|jsx?|mjs|cjs))"
                r"(?:\((\d+)(?:,(\d+))?\)|:(\d+):(\d+))\s*(?:-\s*|:\s*)error\s+(TS\d+):\s*(.+)",
                scrubbed,
            )
            if ts_match:
                file_path = ts_match.group(1)
                line_no = int(ts_match.group(2) or ts_match.group(4) or 0)
                col_no = int(ts_match.group(3) or ts_match.group(5) or 0)
                code = ts_match.group(6)
                msg = ts_match.group(7)
                diag = FailureDiagnostic(
                    category="type_error",
                    message=msg,
                    file=file_path,
                    line=line_no or None,
                    column=col_no or None,
                    symbol=code,
                )
                diagnostics.append(diag)
                type_errors.append(f"[{code}] {file_path}:{line_no}:{col_no}: {msg}")
                implicated_files.append(file_path)
                continue

            # Bare error TSxxxx: message
            bare_ts = re.match(r"error\s+(TS\d+):\s*(.+)", scrubbed)
            if bare_ts:
                code, msg = bare_ts.group(1), bare_ts.group(2)
                diagnostics.append(FailureDiagnostic("type_error", msg, symbol=code))
                type_errors.append(f"[{code}]: {msg}")
                continue

            # ESLint / linter: file:line:col: [error|warning] message [rule]
            lint_match = re.match(
                r"^([a-zA-Z0-9_./-]+\.(?:tsx?|jsx?|mjs|cjs|py)):(\d+):(\d+):\s*(?:error|warning)?\s*(.+?)(?:\s+\[([a-zA-Z0-9_-]+)\])?$",
                scrubbed,
            )
            if lint_match:
                file_path = lint_match.group(1)
                l_no = int(lint_match.group(2))
                c_no = int(lint_match.group(3))
                msg = lint_match.group(4)
                rule = lint_match.group(5)
                lint_errors.append(f"{file_path}:{l_no}:{c_no}: {msg}" + (f" [{rule}]" if rule else ""))
                implicated_files.append(file_path)
                diagnostics.append(FailureDiagnostic("lint_error", msg, file=file_path, line=l_no, column=c_no, symbol=rule))
                continue

            # Vitest / Jest test failure: ✖ <test name> or ✕ <test name> or × <test name>
            symbol_test = re.match(r"^\s*(?:✖|✕|×)\s+(.+)", scrubbed)
            if symbol_test:
                tname = re.sub(r"\s+\(\d+(?:\.\d+)?m?s\)$", "", symbol_test.group(1)).strip()
                if tname and not tname.startswith("failing tests") and not tname.startswith("Test Files"):
                    failing_tests.append(tname)
                    diagnostics.append(FailureDiagnostic("test_failure", tname))
                continue

            # Vitest test suite case: ❯ path/to/file.test.ts > suite > test name
            # (must not be a stack trace frame with :line:col at end)
            if re.match(r"^\s*❯\s+", scrubbed) and not re.search(r":\d+:\d+$", scrubbed):
                test_match = re.match(r"^\s*❯\s+(.+)", scrubbed)
                if test_match:
                    tname = test_match.group(1).strip()
                    if tname:
                        failing_tests.append(tname)
                        diagnostics.append(FailureDiagnostic("test_failure", tname))
                        # Check if leading part is a test file
                        parts = tname.split(" > ", 1)
                        if "." in parts[0]:
                            implicated_files.append(parts[0].strip())
                    continue

            # FAIL <file> or FAILED <file>
            fail_file = re.match(r"^FAIL(?:ED)?\s+(\S+)(.*)", scrubbed)
            if fail_file:
                target_file = fail_file.group(1).strip()
                rest = fail_file.group(2).strip()
                implicated_files.append(target_file)
                if rest and not rest.startswith("("):
                    failing_tests.append(f"{target_file}: {rest}")
                else:
                    failing_tests.append(target_file)
                diagnostics.append(FailureDiagnostic("test_failure", target_file, file=target_file))
                continue

            # node:test or TAP: not ok <num> - <test name>
            tap_match = re.match(r"^not ok\s+\d+\s+[-]?\s*(.*)", scrubbed)
            if tap_match:
                tname = tap_match.group(1).strip() or "unnamed test"
                failing_tests.append(tname)
                diagnostics.append(FailureDiagnostic("test_failure", tname))
                continue

            # Python unittest: FAIL: test_name (module.TestClass)
            py_unittest_fail = re.match(r"^(?:FAIL|ERROR):\s*([a-zA-Z0-9_]+)\s*\((.+)\)", scrubbed)
            if py_unittest_fail:
                tname = f"{py_unittest_fail.group(2)}.{py_unittest_fail.group(1)}"
                failing_tests.append(tname)
                diagnostics.append(FailureDiagnostic("test_failure", tname))
                continue

            # Assertion error pattern: AssertionError: ... or Expected: ... to equal ...
            assert_match = re.match(r"^(?:E\s+)?(AssertionError(?:\s*\[[^]]+\])?\s*:\s*.+)", scrubbed)
            if assert_match:
                amsg = assert_match.group(1)
                assertion_errors.append(amsg)
                diagnostics.append(FailureDiagnostic("assertion_error", amsg))
                continue

            vitest_expect = re.match(r"^\s*Expected:\s+(.+)", scrubbed)
            if vitest_expect:
                amsg = f"Expected: {vitest_expect.group(1)}"
                assertion_errors.append(amsg)
                diagnostics.append(FailureDiagnostic("assertion_error", amsg))
                continue

            # Generic runtime error or exception line: Error: ..., TypeError: ..., ValueError: ...
            err_match = re.match(
                r"^(?:E\s+)?((Error|[A-Z]\w*(?:Error|Exception|Fault)|Uncaught\s+\w+Error)(?:\s*\[[^]]+\])?\s*:\s*.+)",
                scrubbed,
            )
            if err_match and not scrubbed.startswith(("AssertionError", "SyntaxError")):
                emsg = err_match.group(1)
                runtime_errors.append(emsg)
                diagnostics.append(FailureDiagnostic("runtime_error", emsg))
                continue

            # Compile/Syntax error markers: SyntaxError: Unexpected token ..., Cannot find module ...
            syntax_match = re.match(r"^(SyntaxError:\s*.+|Cannot find module\s*.+)", scrubbed)
            if syntax_match:
                cmsg = syntax_match.group(1)
                compile_errors.append(cmsg)
                diagnostics.append(FailureDiagnostic("compile_error", cmsg))
                continue

            # Implicated files extraction
            for match in re.finditer(r"(?:[A-Za-z0-9_.@/-]+\.(?:tsx?|mts|cts|jsx?|mjs|cjs|py|json))(?=[:(\s\"']|$)", scrubbed):
                path = match[0]
                if "node_modules/" not in path and not path.startswith("/usr/") and not path.startswith("/tmp/"):
                    clean_path = path.split("software-factory/", 1)[-1].lstrip("./")
                    if clean_path:
                        implicated_files.append(clean_path)

        if current_trace:
            stack_traces.append("\n".join(current_trace))

        # Deduplicate
        failing_tests = dedup_ordered(failing_tests)
        type_errors = dedup_ordered(type_errors)
        compile_errors = dedup_ordered(compile_errors)
        lint_errors = dedup_ordered(lint_errors)
        assertion_errors = dedup_ordered(assertion_errors)
        runtime_errors = dedup_ordered(runtime_errors)
        implicated_files = dedup_ordered(implicated_files)
        stack_traces = dedup_ordered(stack_traces, 4)

        if is_timeout:
            diagnostics.append(FailureDiagnostic("timeout", f"Execution timed out (exit {exit_code})"))

        summary = self.generate_summary_from_data(
            exit_code, command, is_timeout, failing_tests, type_errors, compile_errors, assertion_errors, runtime_errors
        )
        remediation_hint = self.generate_remediation_hint(
            is_timeout, failing_tests, type_errors, compile_errors, assertion_errors, runtime_errors, implicated_files
        )

        return FailureAnalysis(
            exit_code=exit_code,
            command=command,
            parsed_diagnostics=diagnostics[:60],
            failing_tests=failing_tests,
            type_errors=type_errors,
            compile_errors=compile_errors,
            lint_errors=lint_errors,
            assertion_errors=assertion_errors,
            runtime_errors=runtime_errors,
            implicated_files=implicated_files,
            stack_traces=stack_traces,
            raw_tail=clean_output[-4000:],
            summary=summary[:1200],
            remediation_hint=remediation_hint,
        )

    def generate_summary_from_data(
        self,
        exit_code: int,
        command: str | None,
        is_timeout: bool,
        failing_tests: list[str],
        type_errors: list[str],
        compile_errors: list[str],
        assertion_errors: list[str],
        runtime_errors: list[str],
    ) -> str:
        """Create a compact, human-readable summary of the failure."""
        if is_timeout:
            cmd_note = f" on `{command}`" if command else ""
            return f"Verification command timed out (exit code {exit_code}){cmd_note}"

        parts = []
        if failing_tests:
            n = len(failing_tests)
            preview = ", ".join(failing_tests[:3])
            parts.append(f"{n} test failure(s): {preview}" + (f" (+{n-3} more)" if n > 3 else ""))
        if type_errors:
            n = len(type_errors)
            parts.append(f"{n} TypeScript error(s): {type_errors[0][:90]}" + (f" (+{n-1} more)" if n > 1 else ""))
        if compile_errors:
            n = len(compile_errors)
            parts.append(f"{n} compile error(s): {compile_errors[0][:90]}" + (f" (+{n-1} more)" if n > 1 else ""))
        if assertion_errors and not failing_tests:
            parts.append(f"Assertion failed: {assertion_errors[0][:90]}")
        if runtime_errors:
            parts.append(f"Runtime error: {runtime_errors[0][:90]}")

        if not parts:
            cmd_note = f" for `{command}`" if command else ""
            return f"Verification failed with exit code {exit_code}{cmd_note}"

        return "Verification FAILED: " + "; ".join(parts)

    def generate_summary(self, analysis: FailureAnalysis) -> str:
        return analysis.summary

    def generate_remediation_hint(
        self,
        is_timeout: bool,
        failing_tests: list[str],
        type_errors: list[str],
        compile_errors: list[str],
        assertion_errors: list[str],
        runtime_errors: list[str],
        implicated_files: list[str],
    ) -> str:
        if is_timeout:
            return "Command timed out. Optimize test execution or check for deadlocks, infinite loops, or hanging background processes."

        hints = []
        if type_errors:
            hints.append("Resolve all TypeScript compiler errors and ensure strict type compliance.")
        if compile_errors:
            hints.append("Fix import/syntax/compilation errors preventing test bundle execution.")
        if failing_tests:
            hints.append("Fix failing test assertions: check boundary values, expected output, and mock contracts.")
        if runtime_errors:
            hints.append("Address uncaught exceptions and verify error handling.")
        if implicated_files:
            file_list = ", ".join(f"`{f}`" for f in implicated_files[:6])
            hints.append(f"Primary files to inspect: {file_list}.")
        return " ".join(hints) if hints else "Review the verification output below and correct the failure."

    def synthesize_remediation(
        self,
        task: dict,
        analysis: FailureAnalysis,
        agent: str | None = None,
    ) -> str:
        """Auto-synthesize an actionable remediation prompt for the retrying agent."""
        target_agent = agent or task.get("assigned_agent", "assigned agent")
        command = task.get("verification_cmd") or analysis.command or "verification command"
        # Put the actionable instructions first so verbose diagnostics cannot
        # truncate the repair and re-verification requirements.
        instructions = (
            f"### Self-Healing Remediation Prompt for {target_agent}\n"
            f"Repair task `{task.get('id', 'current-task')}` using the failure diagnostics below.\n"
            f"{analysis.remediation_hint}\n"
            "Inspect the implicated code, reproduce the failure, and make a focused fix. "
            "Preserve the quality gates and existing repository patterns.\n"
            f"Run the full verification command `{command}` before finishing.\n"
            "Leave Git commits, pushes, and roadmap lifecycle updates to the orchestrator.\n\n"
        )
        details = analysis.to_prompt_section() + "\nRaw diagnostic tail:\n" + analysis.raw_tail[-1000:]
        return (instructions + details)[:self.max_feedback_chars]

    def format_feedback(
        self,
        agent: str,
        failure_type: str,
        analysis: FailureAnalysis,
        raw_output: str,
        task: dict | None = None,
    ) -> str:
        """Format the combined feedback string passed to build_prompt on retry."""
        remediation = self.synthesize_remediation(task or {"id": "task"}, analysis, agent)
        header = f"{agent}: {failure_type}\n"
        body = f"{remediation}\n\nRaw diagnostic tail:\n{raw_output[-1500:]}"
        combined = header + body
        if len(combined) > self.max_feedback_chars:
            combined = combined[:self.max_feedback_chars]
        return combined


# Module-level convenience functions
_default_engine = ReflectionEngine()


def analyze_failure(exit_code: int, output: str, command: str | None = None) -> FailureAnalysis:
    return _default_engine.analyze(exit_code, output, command)


def synthesize_remediation_prompt(task: dict, analysis: FailureAnalysis, agent: str | None = None) -> str:
    return _default_engine.synthesize_remediation(task, analysis, agent)


def generate_failure_summary(analysis: FailureAnalysis) -> str:
    return _default_engine.generate_summary(analysis)


def format_feedback(
    agent: str, failure_type: str, analysis: FailureAnalysis, raw_output: str, task: dict | None = None,
) -> str:
    return _default_engine.format_feedback(agent, failure_type, analysis, raw_output, task)
