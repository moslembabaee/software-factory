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
    stderr: str = ""
    correlated_files: list[dict] = field(default_factory=list)
    diff_summary: str = ""

    def to_dict(self) -> dict:
        data = asdict(self)
        data["parsed_diagnostics"] = [
            d if isinstance(d, dict) else asdict(d) for d in self.parsed_diagnostics
        ]
        data["correlated_files"] = [
            c if isinstance(c, dict) else asdict(c) for c in self.correlated_files
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
        correlated = []
        for c in data.get("correlated_files", []):
            if isinstance(c, CorrelatedFile):
                correlated.append(c.to_dict())
            elif isinstance(c, dict):
                correlated.append(c)
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
            stderr=str(data.get("stderr", "")),
            correlated_files=correlated,
            diff_summary=str(data.get("diff_summary", "")),
        )

    def to_prompt_section(self, max_length: int = 4000) -> str:
        """Render the structured reflection diagnostics as a clean markdown block."""
        parts = [f"## Verification Failure Diagnostics (exit code {self.exit_code})"]
        if self.command:
            parts.append(f"Command: `{self.command}`")
        parts.append(f"Summary: {self.summary}")

        if self.correlated_files:
            parts.append("\n### Correlated Files (Diff & Root Cause):")
            for c in self.correlated_files[:8]:
                cf = c if isinstance(c, dict) else asdict(c)
                rel = f" - {cf.get('relevance')}" if cf.get("relevance") else ""
                parts.append(f"- `{cf.get('file')}` [{cf.get('confidence', 'medium')} confidence]{rel}")

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

        if self.implicated_files and not self.correlated_files:
            parts.append("\n### Implicated Files to Inspect:")
            for f in self.implicated_files[:12]:
                parts.append(f"- `{f}`")

        if self.stack_traces:
            parts.append("\n### Diagnostic Stack Trace:")
            for st in self.stack_traces[:2]:
                lines = st.splitlines()[:10]
                parts.append("```\n" + "\n".join(lines) + "\n```")

        if self.stderr:
            parts.append(f"\n### Stderr Diagnostic Output:\n```\n{self.stderr[:1000]}\n```")

        if self.diff_summary:
            parts.append(f"\n### Recent File Diff Summary:\n{self.diff_summary}")

        if self.remediation_hint:
            parts.append(f"\n### Remediation Suggestion:\n{self.remediation_hint}")

        result = "\n".join(parts)
        if len(result) > max_length:
            return result[:max_length - 20] + "\n... [truncated]"
        return result


def parse_git_diff(diff_output: str) -> list[DiffFileInfo]:
    """Parse unified git diff output into structured DiffFileInfo records."""
    result: list[DiffFileInfo] = []
    current_file: DiffFileInfo | None = None

    for line in diff_output.splitlines():
        if line.startswith("diff --git"):
            if current_file:
                result.append(current_file)
            parts = line.split(" ")
            b_path = parts[-1].lstrip("b/").strip() if len(parts) >= 4 else ""
            current_file = DiffFileInfo(path=b_path, status="modified")
        elif current_file and line.startswith("new file mode"):
            current_file.status = "added"
        elif current_file and line.startswith("deleted file mode"):
            current_file.status = "deleted"
        elif current_file and line.startswith("+++ "):
            path = line[4:].strip().lstrip("b/")
            if path != "/dev/null" and path:
                current_file.path = path
            elif path == "/dev/null":
                current_file.status = "deleted"
        elif current_file and line.startswith("--- "):
            path = line[4:].strip().lstrip("a/")
            if path == "/dev/null":
                current_file.status = "added"
        elif current_file and line.startswith("@@"):
            hunk_match = re.search(r"@@\s*-\d+(?:,\d+)?\s+\+(\d+)(?:,(\d+))?\s*@@", line)
            if hunk_match:
                new_start = int(hunk_match.group(1))
                new_count = int(hunk_match.group(2)) if hunk_match.group(2) is not None else 1
                if new_count > 0:
                    lines_range = list(range(new_start, new_start + new_count))
                    if current_file.status == "added":
                        current_file.added_lines.extend(lines_range)
                    else:
                        current_file.modified_lines.extend(lines_range)
    if current_file:
        result.append(current_file)
    return result


def get_recent_diff_files(project_root: Path | str, runner: Callable = None) -> list[DiffFileInfo]:
    """Inspect git diff and git status to collect recently modified and untracked files."""
    from command_runner import run_cmd
    run = runner or run_cmd
    root = Path(project_root).resolve()
    diff_files: list[DiffFileInfo] = []
    try:
        code, out = run(["git", "diff", "HEAD", "-U0"], 30, root)
        if code == 0 and out.strip():
            diff_files.extend(parse_git_diff(out))
    except Exception:
        pass

    try:
        code, out = run(["git", "status", "--porcelain"], 30, root)
        if code == 0 and out.strip():
            existing = {d.path for d in diff_files}
            for raw_line in out.splitlines():
                line = raw_line.strip()
                if not line:
                    continue
                if line.startswith("??"):
                    p = line[2:].strip()
                    if p and p not in existing:
                        diff_files.append(DiffFileInfo(path=p, status="untracked"))
                        existing.add(p)
                elif line.startswith(("M", "A", "D")) or (len(line) > 1 and line[1] in ("M", "A", "D")):
                    p = line[2:].strip()
                    if " -> " in p:
                        p = p.split(" -> ")[1].strip()
                    if p and p not in existing:
                        status: DiffFileStatus = "deleted" if "D" in line[:2] else "added" if "A" in line[:2] else "modified"
                        diff_files.append(DiffFileInfo(path=p, status=status))
                        existing.add(p)
    except Exception:
        pass
    return diff_files


def generate_diff_summary(diff_files: list[DiffFileInfo | dict | str]) -> str:
    """Generate a compact human-readable summary of changed files."""
    if not diff_files:
        return "No recent changes detected in working tree"
    parts = []
    for d in diff_files[:10]:
        if isinstance(d, str):
            parts.append(f"- MODIFIED `{d}`")
        elif isinstance(d, dict):
            status = d.get("status", "modified").upper()
            path = d.get("path") or d.get("file", "")
            lines = d.get("modified_lines") or d.get("added_lines") or []
            lines_str = f" (lines: {lines[:5]})" if lines else ""
            parts.append(f"- {status} `{path}`{lines_str}")
        elif isinstance(d, DiffFileInfo):
            status = d.status.upper()
            lines = d.modified_lines or d.added_lines or []
            lines_str = f" (lines: {lines[:5]})" if lines else ""
            parts.append(f"- {status} `{d.path}`{lines_str}")
    if len(diff_files) > 10:
        parts.append(f"- ... (+{len(diff_files) - 10} more)")
    return "\n".join(parts)


def correlate_failure_with_diff(
    analysis: FailureAnalysis,
    diff_files: list[str | dict | DiffFileInfo],
) -> list[CorrelatedFile]:
    """Correlate parsed failure diagnostics with recently modified files from git diff."""
    normalized: list[DiffFileInfo] = []
    for item in diff_files:
        if isinstance(item, str):
            normalized.append(DiffFileInfo(path=item.strip(), status="modified"))
        elif isinstance(item, dict):
            normalized.append(DiffFileInfo(
                path=item.get("path") or item.get("file", ""),
                status=item.get("status", "modified"),
                added_lines=list(item.get("added_lines", [])),
                modified_lines=list(item.get("modified_lines", [])),
            ))
        elif isinstance(item, DiffFileInfo):
            normalized.append(item)

    correlated: list[CorrelatedFile] = []
    diff_paths = {d.path for d in normalized}

    for diff_item in normalized:
        file_path = diff_item.path
        if not file_path:
            continue
        error_types: list[str] = []
        error_lines: list[int] = []
        confidence: ConfidenceLevel = "low"
        relevance = "Modified in recent diff"
        is_implicated = False

        # 1. Parsed diagnostics (type errors, compiler errors, etc.)
        for diag in analysis.parsed_diagnostics:
            if diag.file and (diag.file == file_path or file_path.endswith(diag.file) or diag.file.endswith(file_path)):
                is_implicated = True
                if diag.category not in error_types:
                    error_types.append(diag.category)
                if diag.line is not None:
                    if diag.line not in error_lines:
                        error_lines.append(diag.line)
                    is_line_in_diff = (
                        diag.line in diff_item.added_lines or
                        diag.line in diff_item.modified_lines
                    )
                    if is_line_in_diff:
                        confidence = "high"
                        relevance = f"Direct line match: {diag.category} at line {diag.line}"
                    elif confidence != "high":
                        confidence = "high"
                        relevance = f"Direct file match: {diag.category} at line {diag.line}"
                elif confidence != "high":
                    confidence = "high"
                    relevance = f"File referenced in {diag.category}: {diag.message[:80]}"

        # 2. Stack traces
        for trace in analysis.stack_traces:
            if file_path in trace:
                is_implicated = True
                if "stack_trace" not in error_types:
                    error_types.append("stack_trace")
                if confidence != "high":
                    confidence = "high"
                    relevance = "File referenced in stack trace frame"

        # 3. Failing tests
        for test_name in analysis.failing_tests:
            if file_path in test_name:
                is_implicated = True
                if "test_failure" not in error_types:
                    error_types.append("test_failure")
                confidence = "high"
                relevance = f"Direct failing test: {test_name[:80]}"
            else:
                base = re.sub(r"\.(?:tsx?|jsx?|mjs|cjs|py)$", "", file_path)
                if base and base in test_name:
                    is_implicated = True
                    if "test_failure" not in error_types:
                        error_types.append("test_failure")
                    if confidence != "high":
                        confidence = "medium"
                        relevance = f"Target of failing test: {test_name[:80]}"

        # 4. Implicated files list
        if not is_implicated:
            for f in analysis.implicated_files:
                if f == file_path or file_path.endswith(f) or f.endswith(file_path):
                    is_implicated = True
                    error_types.append("implicated_file")
                    if confidence == "low":
                        confidence = "medium"
                        relevance = "Referenced in failure diagnostics"
                    break

        if is_implicated or file_path in diff_paths:
            correlated.append(CorrelatedFile(
                file=file_path,
                status=diff_item.status,
                implicated=is_implicated,
                error_types=error_types,
                error_lines=error_lines,
                confidence=confidence,
                relevance=relevance,
            ))

    rank = {"high": 3, "medium": 2, "low": 1}
    correlated.sort(key=lambda c: (rank.get(c.confidence, 0), len(c.error_lines)), reverse=True)
    return correlated


def generate_remediation_task_id(parent_task_id: str, existing_ids: list[str]) -> str:
    """Generate a deterministic remediation task ID avoiding collisions."""
    base = f"{parent_task_id}-REMEDY"
    if base not in existing_ids:
        return base
    index = 2
    while f"{base}-{index}" in existing_ids:
        index += 1
    return f"{base}-{index}"


def synthesize_remediation_task(
    parent_task: dict,
    analysis: FailureAnalysis,
    existing_ids: list[str],
) -> dict:
    """Synthesize a localized remediation task dictionary matching LocalizedRemediationTaskSchema."""
    remedy_id = generate_remediation_task_id(parent_task["id"], existing_ids)
    correlated = analysis.correlated_files or []
    top_correlated = [
        c for c in correlated
        if (c.get("confidence") if isinstance(c, dict) else c.confidence) in ("high", "medium")
    ]

    if top_correlated:
        implicated_file_names = [
            c.get("file") if isinstance(c, dict) else c.file for c in top_correlated
        ]
    else:
        implicated_file_names = analysis.implicated_files[:6]

    verification_cmd = parent_task.get("verification_cmd") or "npm run typecheck && npm test"

    lines: list[str] = [
        "### 🛠️ Autonomous Localized Remediation Task",
        "",
        f"Remediate verification failure for parent task `{parent_task['id']}`.",
        "",
        f"- **Parent Task:** `{parent_task['id']}` — {parent_task.get('title', '')}",
        f"- **Exit Code:** `{analysis.exit_code}`",
        f"- **Verification Command:** `{verification_cmd}`",
        "",
        "#### Failure Summary",
        analysis.summary,
        "",
    ]

    if top_correlated:
        lines.append("#### Correlated Files (Localized Root Cause)")
        for c in top_correlated:
            c_dict = c if isinstance(c, dict) else c.to_dict()
            rel = f": {c_dict['relevance']}" if c_dict.get("relevance") else ""
            lines.append(f"- `{c_dict['file']}` [{c_dict.get('confidence', 'medium')} confidence]{rel}")
        lines.append("")
    elif implicated_file_names:
        lines.append("#### Implicated Files to Inspect")
        for f in implicated_file_names:
            lines.append(f"- `{f}`")
        lines.append("")

    if analysis.failing_tests:
        lines.append("#### Failing Tests")
        lines.extend([f"- `{t}`" for t in analysis.failing_tests[:5]])
        lines.append("")

    if analysis.type_errors:
        lines.append("#### TypeScript Type Errors")
        lines.extend([f"- {e}" for e in analysis.type_errors[:5]])
        lines.append("")

    if analysis.stack_traces:
        lines.append("#### Diagnostic Stack Trace")
        lines.append("```")
        lines.append(analysis.stack_traces[0][:1500])
        lines.append("```")
        lines.append("")

    hint = analysis.remediation_hint or "Inspect the correlated files, reproduce the failure, and make a focused fix."
    lines.extend([
        "#### Remediation Instructions",
        hint,
        f"Run `{verification_cmd}` before finishing.",
        "Leave Git commits, pushes, and roadmap lifecycle updates to the orchestrator.",
        "",
        f"<!-- factory-remediation-for: {parent_task['id']} -->",
    ])

    return {
        "id": remedy_id,
        "parent_task_id": parent_task["id"],
        "title": f"Remediation: Fix verification failure in {parent_task['id']}: {analysis.summary}"[:120],
        "description": "\n".join(lines),
        "phase": parent_task.get("phase", "Continuous Polish & Evolution"),
        "status": "approved",
        "assigned_agent": parent_task.get("assigned_agent", "claude"),
        "verification_cmd": verification_cmd,
        "implicated_files": implicated_file_names,
        "correlated_files": [c if isinstance(c, dict) else c.to_dict() for c in correlated],
        "is_remediation": True,
        "tenant_id": parent_task.get("tenant_id"),
        "project_id": parent_task.get("project_id"),
        "github_issue_number": parent_task.get("github_issue_number"),
        "created_at": datetime.now(timezone.utc).isoformat(),
    }


class ReflectionEngine:
    """Automated reflection engine for analyzing failures and synthesizing remediation."""

    def __init__(self, max_feedback_chars: int = 4000) -> None:
        self.max_feedback_chars = max_feedback_chars

    def analyze(
        self,
        exit_code: int,
        output: str,
        command: str | None = None,
        stderr: str = "",
        diff_files: list[str | dict | DiffFileInfo] | None = None,
        diff_summary: str = "",
    ) -> FailureAnalysis:
        """Parse verification output and produce a structured FailureAnalysis."""
        # Clean ANSI escape sequences
        clean_output = anonymize_secrets(re.sub(r"\x1b\[[0-?]*[ -/]*[@-~]", "", output[-64000:]))
        clean_stderr = anonymize_secrets(re.sub(r"\x1b\[[0-?]*[ -/]*[@-~]", "", stderr[-32000:])) if stderr else ""
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

        if not clean_stderr and exit_code != 0:
            stderr_parts = []
            if stack_traces:
                stderr_parts.extend(stack_traces[:2])
            if type_errors:
                stderr_parts.extend(type_errors[:3])
            if compile_errors:
                stderr_parts.extend(compile_errors[:3])
            if runtime_errors:
                stderr_parts.extend(runtime_errors[:3])
            if stderr_parts:
                clean_stderr = "\n".join(stderr_parts)[:4000]

        correlated_list: list[dict] = []
        if diff_files:
            temp_analysis = FailureAnalysis(
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
            )
            correlated_objects = correlate_failure_with_diff(temp_analysis, diff_files)
            correlated_list = [c.to_dict() for c in correlated_objects]

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
            stderr=clean_stderr,
            correlated_files=correlated_list,
            diff_summary=diff_summary or (generate_diff_summary(diff_files) if diff_files else ""),
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


def analyze_failure(
    exit_code: int,
    output: str,
    command: str | None = None,
    stderr: str = "",
    diff_files: list[str | dict | DiffFileInfo] | None = None,
    diff_summary: str = "",
) -> FailureAnalysis:
    return _default_engine.analyze(
        exit_code, output, command, stderr=stderr, diff_files=diff_files, diff_summary=diff_summary
    )


def synthesize_remediation_prompt(task: dict, analysis: FailureAnalysis, agent: str | None = None) -> str:
    return _default_engine.synthesize_remediation(task, analysis, agent)


def generate_failure_summary(analysis: FailureAnalysis) -> str:
    return _default_engine.generate_summary(analysis)


def format_feedback(
    agent: str, failure_type: str, analysis: FailureAnalysis, raw_output: str, task: dict | None = None,
) -> str:
    return _default_engine.format_feedback(agent, failure_type, analysis, raw_output, task)
