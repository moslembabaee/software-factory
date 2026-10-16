#!/usr/bin/env python3
"""Bounded PR publication for the trusted repository worker (never tenant input).

All entry points re-read verification evidence and serialize Git mutations. GitHub
is polled once per worker tick; no command waits for CI or bypasses branch rules.
"""
from __future__ import annotations

import argparse
from contextlib import contextmanager
from datetime import datetime, timezone
import time
import fcntl
import json
import math
from pathlib import Path
from queue import Empty, Queue
import re
import tempfile
from threading import Thread
from typing import Callable

import build_events
from command_runner import OUTPUT_LIMIT, run_cmd
from issue_lifecycle import issue_number_for_task, record_sync_history
import roadmap_store

PROJECT_ROOT = Path(__file__).resolve().parent
DEFAULT_REPO = "moslembabaee/software-factory"
DEFAULT_BASE_BRANCH = "main"
DEFAULT_REMOTE = "origin"
Runner = Callable[[list[str], float, Path], tuple[int, str]]
PR_FIELDS = ("number,url,state,headRefName,baseRefName,headRefOid,baseRefOid,isDraft,"
             "reviewDecision,mergeStateStatus,statusCheckRollup,mergeCommit,mergedAt")
EVIDENCE_FIELDS = ("verification_cmd", "verifications", "build_approval", "started_at",
                   "title", "description", "phase", "requirements", "acceptance_criteria", "verification_gates",
                   "branch", "base_branch", "commit_sha", "pr_number",
                   "is_bugfix", "parent_task_id", "target_branch", "source_commit_sha",
                   "regression_context", "tenant_id", "project_id", "repair_commit_sha")


def timestamp() -> str:
    return datetime.now(timezone.utc).isoformat()


def get_task_branch_name(task: dict | str, prefix: str = "factory") -> str:
    if isinstance(task, dict) and task.get("branch"):
        return str(task["branch"])
    task_id = task if isinstance(task, str) else task["id"]
    sanitized = re.sub(r"[^a-zA-Z0-9-]+", "-", task_id).strip("-").lower()[:120]
    if not sanitized or not re.fullmatch(r"[a-zA-Z0-9-]+", prefix):
        raise ValueError("Invalid task ID or branch prefix")
    return f"{prefix}/{sanitized}"


def load_maintainers(project_root: Path = PROJECT_ROOT) -> dict:
    data = json.loads((project_root / "maintainers.json").read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        raise ValueError("maintainers.json must contain an object")
    return data


def get_pr_reviewers(maintainers_data: dict | None = None,
                     project_root: Path = PROJECT_ROOT) -> list[str]:
    data = maintainers_data if maintainers_data is not None else load_maintainers(project_root)
    reviewers = data.get("reviewers", data.get("authorized_approvers", []))
    if not isinstance(reviewers, list) or any(
        not isinstance(r, str) or not re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9-]*", r)
        for r in reviewers
    ):
        raise ValueError("Maintainer reviewers must be GitHub usernames")
    return list(dict.fromkeys(reviewers))


def build_pr_metadata(task: dict, maintainers_data: dict | None = None,
                      project_root: Path = PROJECT_ROOT,
                      base_branch: str = DEFAULT_BASE_BRANCH) -> dict:
    reviewers = get_pr_reviewers(maintainers_data, project_root)
    branch = get_task_branch_name(task)
    lines = ["### Autonomous Software Factory Pull Request", "",
             f"- **Task ID:** `{task['id']}`", f"- **Phase:** {task.get('phase', '')}",
             f"- **Assigned Agent:** `{task.get('assigned_agent', '')}`",
             f"- **Branch:** `{branch}`", "", "#### Description & Requirements",
             str(task.get("description", "")), ""]
    for field in ("requirements", "acceptance_criteria", "verification_gates"):
        values = task.get(field, [])
        if values:
            lines += [f"#### {field.replace('_', ' ').title()}"]
            for value in values if isinstance(values, list) else [values]:
                lines.append(f"- {value if isinstance(value, str) else json.dumps(value)}")
            lines.append("")
    lines += ["#### Quality Gate Verification", "```bash",
              task.get("verification_cmd", ""), "```", "Verification outcome: **PASSED**", ""]
    issue = issue_number_for_task(task)
    if issue:
        lines += [f"Closes #{issue}", ""]
    lines += [f"<!-- factory-task-id: {task['id']} -->", f"<!-- factory-branch: {branch} -->"]
    return {"title": f"feat({task['id']}): {task['title']}"[:120], "body": "\n".join(lines),
            "branch": branch, "base": base_branch, "reviewers": reviewers}


def _load_task(root: Path, task_id: str) -> dict:
    data = json.loads((root / "ROADMAP.json").read_text(encoding="utf-8"))
    task = next((t for t in data["tasks"] if t["id"] == task_id), None)
    if task is None:
        raise ValueError(f"Unknown task: {task_id}")
    return task


def _verified(task: dict) -> bool:
    records = task.get("verifications", [])
    return bool(task.get("status") == "verified" and not task.get("closed_at")
                and isinstance(task.get("verification_cmd"), str) and task["verification_cmd"].strip()
                and records and records[-1].get("exit_code") == 0
                and not records[-1].get("skipped")
                and records[-1].get("command") == task["verification_cmd"])


def publication_evidence(task: dict) -> dict:
    return {k: task.get(k) for k in EVIDENCE_FIELDS
            if k not in ("branch", "base_branch", "commit_sha", "pr_number")}


def repair_parent(task: dict, tasks: list[dict], depth: int = 0) -> dict:
    """Validate the repair's live lineage before dispatch, push or merge."""
    parent = next((t for t in tasks if t["id"] == task.get("parent_task_id")), None)
    if (depth >= MAX_HEALING_ATTEMPTS or not parent or not _verified(parent)
            or parent.get("bugfix_task_id") != task["id"]
            or parent.get("commit_sha") != task.get("source_commit_sha")
            or parent.get("branch") != task.get("target_branch")
            or parent.get("base_branch") != task.get("base_branch")
            or parent.get("published_evidence") != publication_evidence(parent)
            or any(parent.get(k) != task.get(k) for k in ("tenant_id", "project_id"))):
        raise ValueError("CI repair parent changed")
    if parent.get("is_bugfix"):
        repair_parent(parent, tasks, depth + 1)
    return parent


def _current(root: Path, snapshot: dict) -> bool:
    data = json.loads((root / "ROADMAP.json").read_text(encoding="utf-8"))
    task = next((t for t in data["tasks"] if t["id"] == snapshot["id"]), {})
    if not _verified(task) or any(task.get(k) != snapshot.get(k) for k in EVIDENCE_FIELDS):
        return False
    if task.get("is_bugfix"):
        try:
            repair_parent(task, data["tasks"])
        except ValueError:
            return False
    return True


def _record(root: Path, snapshot: dict, *, release_checkout: bool = True, **fields: object) -> bool:
    def apply(data: dict) -> bool:
        task = next((t for t in data["tasks"] if t["id"] == snapshot["id"]), None)
        if (not task or not _verified(task)
                or any(task.get(k) != snapshot.get(k) for k in EVIDENCE_FIELDS)
                or task.get("pr_number") != snapshot.get("pr_number")):
            return False
        if task.get("is_bugfix"):
            try:
                repair_parent(task, data["tasks"])
            except ValueError:
                return False
        changed = any(task.get(k) != value for k, value in fields.items())
        task.update(fields)
        if fields.get("pr_status") == "merged":
            ancestor = task
            for _ in range(MAX_HEALING_ATTEMPTS):
                parent = next((t for t in data["tasks"] if t["id"] == ancestor.get("parent_task_id")), None)
                if (not parent or parent.get("closed_at") or parent.get("bugfix_task_id") != ancestor["id"]
                        or parent.get("commit_sha") != ancestor.get("source_commit_sha")):
                    break
                parent.update(status="completed", pr_status="merged", ci_status="passed",
                              merge_commit_sha=fields["merge_commit_sha"], completed_at=fields["completed_at"],
                              merged_at=fields["merged_at"], publication_error=None)
                ancestor = parent
            fix = next((t for t in data["tasks"] if t["id"] == task.get("bugfix_task_id")), None)
            if fix and fix.get("status") == "approved":
                fix.update(status="cancelled", closed_at=fields["completed_at"],
                           last_error="Original CI recovered before remediation")
        if release_checkout and data.get("current_task_id") == task["id"]:
            data["current_task_id"] = None
        if changed:
            record_sync_history(data, task, {
                "timestamp": timestamp(), "task_id": task["id"], "action": "pr_lifecycle",
                "pr_number": task.get("pr_number"), "message": str(fields),
            })
        return True
    return roadmap_store.update_roadmap(root / "ROADMAP.json", apply)


@contextmanager
def _lock(root: Path):
    (root / "logs").mkdir(exist_ok=True)
    with (root / "logs" / "pr-lifecycle.lock").open("a") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            yield False
        else:
            yield True


def create_and_checkout_branch(branch_name: str, project_root: Path,
                               base_branch: str = DEFAULT_BASE_BRANCH,
                               runner: Runner = run_cmd, timeout: float = 60) -> tuple[bool, str]:
    for ref in (branch_name, base_branch):
        code, out = runner(["git", "check-ref-format", "--branch", ref], timeout, project_root)
        if code or ref.startswith("-") or ref == "HEAD":
            return False, f"Invalid branch: {ref}: {out}"
    if branch_name == base_branch:
        return False, "Task branch must differ from the base branch"
    code, current = runner(["git", "branch", "--show-current"], timeout, project_root)
    if code:
        return False, current
    if current.strip() == branch_name:
        return True, current
    if current.strip() != base_branch:
        return False, f"Checkout is on {current.strip()!r}; expected {base_branch!r}"
    # -b refuses existing branches. Never reset or force-push a previous attempt.
    code, out = runner(["git", "checkout", "-b", branch_name, base_branch], timeout, project_root)
    return code == 0, out


def commit_task_changes(task: dict, project_root: Path, runner: Runner = run_cmd,
                        timeout: float = 60) -> tuple[bool, str]:
    code, out = runner(["git", "diff", "--cached", "--name-only", "--", "ROADMAP.json", "ROADMAP.md"],
                       timeout, project_root)
    if code or out.strip():
        return False, f"Runtime control files must not be staged: {out}"
    # Runtime control files stay live on disk; publishing them would replay stale
    # roadmap state when a PR merges and make switching back to base unsafe.
    code, out = runner(["git", "add", "--all", "--", ".", ":(exclude)ROADMAP.json",
                        ":(exclude)ROADMAP.md"],
                       timeout, project_root)
    if code:
        return False, f"git add failed: {out}"
    code, out = runner(["git", "diff", "--cached", "--quiet"], timeout, project_root)
    if code not in (0, 1):
        return False, f"git diff failed: {out}"
    if code == 1:
        code, out = runner(["git", "-c", "commit.gpgsign=false", "commit", "-m",
                            f"feat({task['id']}): {task['title']}"], timeout, project_root)
        if code:
            return False, f"git commit failed: {out}"
    code, out = runner(["git", "rev-parse", "HEAD"], timeout, project_root)
    return code == 0, out.strip()


def _json(command: list[str], root: Path, runner: Runner, timeout: float) -> object:
    code, out = runner(command, timeout, root)
    if code:
        raise ValueError(f"{' '.join(command[:3])} failed ({code}): {out}")
    return json.loads(out)


def create_pull_request(task: dict, project_root: Path, repo: str = DEFAULT_REPO,
                        base_branch: str = DEFAULT_BASE_BRANCH,
                        maintainers_data: dict | None = None, runner: Runner = run_cmd,
                        timeout: float = 120) -> tuple[bool, dict]:
    meta = build_pr_metadata(task, maintainers_data, project_root, base_branch)
    author = _json(["gh", "api", "user"], project_root, runner, timeout)["login"]
    reviewers = [r for r in meta["reviewers"] if r.lower() != author.lower()]
    existing = _json(["gh", "pr", "list", "--repo", repo, "--head", meta["branch"],
                      "--base", base_branch, "--state", "all", "--json", "number,url,state"],
                     project_root, runner, timeout)
    if not isinstance(existing, list):
        raise ValueError("Invalid PR lookup response")
    if existing:
        info = existing[0]
        if info.get("state") != "OPEN":
            return False, {"error": "Task branch already has a closed or merged PR"}
    else:
        # GitHub cannot request review from the PR author.
        with tempfile.TemporaryDirectory(prefix="sf-pr-") as directory:
            body = Path(directory) / "body.md"
            body.write_text(meta["body"], encoding="utf-8")
            command = ["gh", "pr", "create", "--repo", repo, "--head", meta["branch"],
                       "--base", base_branch, "--title", meta["title"], "--body-file", str(body)]
            if reviewers:
                command += ["--reviewer", ",".join(reviewers)]
            code, out = runner(command, timeout, project_root)
        # Re-query even after a timeout: creation may have reached GitHub.
        existing = _json(["gh", "pr", "list", "--repo", repo, "--head", meta["branch"],
                          "--base", base_branch, "--state", "all", "--json", "number,url,state"],
                         project_root, runner, timeout)
        if not existing:
            return False, {"error": f"gh pr create failed ({code}): {out}"}
        info = existing[0]
    if (info.get("state") != "OPEN" or not isinstance(info.get("number"), int)
            or not isinstance(info.get("url"), str)):
        return False, {"error": "Invalid open PR response"}
    if reviewers:
        code, out = runner(["gh", "pr", "edit", str(info["number"]), "--repo", repo,
                            "--add-reviewer", ",".join(reviewers)], timeout, project_root)
        if code:
            return False, {"error": f"Reviewer assignment failed ({code}): {out}"}
    return True, {"pr_number": info["number"], "pr_url": info["url"],
                  "reviewers": reviewers}


def check_pr_ci_status(pr_number: int, project_root: Path, repo: str = DEFAULT_REPO,
                       runner: Runner = run_cmd, timeout: float = 60) -> dict:
    try:
        info = _json(["gh", "pr", "view", str(pr_number), "--repo", repo, "--json", PR_FIELDS],
                     project_root, runner, timeout)
        if not isinstance(info, dict) or not info.get("headRefOid"):
            raise ValueError("Invalid PR response")
        checks = info.get("statusCheckRollup") or []
        states = []
        for check in checks:
            if check.get("__typename") == "StatusContext" or "state" in check:
                states.append(str(check.get("state", "PENDING")).upper())
            elif check.get("status") == "COMPLETED":
                states.append(str(check.get("conclusion", "PENDING")).upper())
            else:
                states.append("PENDING")
        if any(s in {"FAILURE", "ERROR", "CANCELLED", "TIMED_OUT", "ACTION_REQUIRED", "STARTUP_FAILURE", "STALE"} for s in states):
            status = "failed"
        elif states and "SUCCESS" in states and all(s in {"SUCCESS", "NEUTRAL", "SKIPPED"} for s in states):
            status = "passed"
        else:
            status = "pending"
        return {"status": status, "pr": info}
    except (ValueError, TypeError, KeyError, AttributeError) as error:
        return {"status": "unknown", "error": str(error)}


def parse_ci_error_logs(logs: str) -> dict:
    """Parse bounded, normalized diagnostics one line at a time (no backtracking blocks)."""
    logs = re.sub(r"\x1b\[[0-?]*[ -/]*[@-~]", "", logs[-64000:])
    lines = []
    for line in logs.splitlines():
        # gh run view prefixes each line with job, step and an ISO timestamp.
        line = re.sub(r"^.*?\d{4}-\d\d-\d\dT[\d:.]+Z\s*", "", line[:4000])
        lines.append(line.replace("##[error]", "").rstrip())
    groups: dict[str, list[str]] = {k: [] for k in
        ("failing_tests", "error_messages", "stack_traces", "failing_files")}

    def add(key: str, value: str) -> None:
        value = value.strip()[:4000 if key == "stack_traces" else 1000]
        if value and value not in groups[key] and len(groups[key]) < 30:
            groups[key].append(value)

    trace: list[str] = []
    python_trace = False
    for line in lines:
        clean = line.strip()
        match = re.match(r"(?:FAIL|ERROR):\s*(.+)", clean)
        if match:
            add("failing_tests", match[1])
        match = re.match(r"FAIL\s+(\S+)(.*)", clean)
        if match:
            add("failing_tests", match[1])
            add("failing_files", match[1])
            if match[2].strip():
                add("failing_tests", clean[5:])
        match = re.match(r"(?:✖|✕|×|not ok \d+\s*-?)\s+(.+)", clean)
        if match and not match[1].startswith("failing tests"):
            add("failing_tests", re.sub(r"\s+\(\d+(?:\.\d+)?m?s\)$", "", match[1]))
        match = re.match(r"FAILED\s+(\S+)", clean)
        if match:
            add("failing_tests", match[1])
        match = re.search(r"test at (.+)", clean)
        if match:
            add("failing_tests", match[1])
        match = re.search(r"error (TS\d+:[^\n]+)", clean)
        if match:
            add("error_messages", "error " + match[1])
        match = re.match(r"(?:E\s+)?((?:[A-Z]\w*(?:Error|Exception)|Error|Exception)(?:\s*\[[^]]+\])?:.*)", clean)
        if match:
            add("error_messages", match[1])
        if clean.startswith("Traceback (most recent call last):"):
            if trace:
                add("stack_traces", "\n".join(trace))
            trace, python_trace = [line], True
        elif python_trace:
            trace.append(line)
            if match or len(trace) >= 30:
                add("stack_traces", "\n".join(trace))
                trace, python_trace = [], False
        elif re.match(r"(?:at|❯)\s+", clean):
            trace.append(line)
            if len(trace) >= 30:
                add("stack_traces", "\n".join(trace))
                trace = []
        elif trace:
            add("stack_traces", "\n".join(trace))
            trace = []
        for match in re.finditer(r"(?:[A-Za-z0-9_.@/-]+\.(?:tsx?|jsx?|mjs|cjs|py))(?=[:(\s\"']|$)", line):
            path = match[0]
            if "node_modules/" not in path and not path.startswith("/usr/"):
                add("failing_files", path.split("software-factory/", 1)[-1])
    if trace:
        add("stack_traces", "\n".join(trace))
    tests, errors = groups["failing_tests"], groups["error_messages"]
    summary = (f"CI regression in {len(tests)} test(s): {', '.join(tests[:3])}" if tests
               else "CI build/test failure detected")
    if errors:
        summary = (summary + ". Error: " if tests else "CI failure: ") + errors[0]
    return {**groups, "raw_log_tail": "\n".join(lines)[-4000:], "summary": summary[:300]}


def generate_bugfix_task_id(parent_task_id: str, existing_ids: list[str]) -> str:
    base = f"{parent_task_id}-FIX"
    if base not in existing_ids:
        return base
    index = 2
    while f"{base}-{index}" in existing_ids:
        index += 1
    return f"{base}-{index}"


def create_bugfix_task(parent_task: dict, regression: dict, branch: str, existing_ids: list[str]) -> dict:
    bugfix_id = generate_bugfix_task_id(parent_task["id"], existing_ids)
    issue_num = issue_number_for_task(parent_task)
    lines = [
        "### 🤖 Autonomous Self-Healing Bugfix",
        "",
        f"Remediate CI build regression on branch `{branch}`.",
        "",
        f"- **Parent Task:** `{parent_task['id']}` — {parent_task.get('title', '')}",
        f"- **Target Branch:** `{branch}`",
        "",
        "#### Regression Summary",
        regression.get("summary", ""),
        "",
    ]
    if regression.get("failing_tests"):
        lines += ["#### Failing Tests"] + [f"- `{t}`" for t in regression["failing_tests"]] + [""]
    if regression.get("error_messages"):
        lines += ["#### Error Messages"] + [f"- `{e}`" for e in regression["error_messages"]] + [""]
    if regression.get("failing_files"):
        lines += ["#### Implicated Files"] + [f"- `{f}`" for f in regression["failing_files"]] + [""]
    if regression.get("stack_traces"):
        lines += ["#### Diagnostic Stack Trace", "```", regression["stack_traces"][0], "```", ""]
    elif regression.get("raw_log_tail"):
        lines += ["#### Error Log Snippet", "```", regression["raw_log_tail"][-1500:], "```", ""]
    if issue_num:
        lines += [f"Reference: Parent Issue #{issue_num}", ""]
    lines += [f"<!-- factory-bugfix-for: {parent_task['id']} -->", f"<!-- factory-branch: {branch} -->"]

    return {
        **{k: parent_task[k] for k in ("tenant_id", "project_id") if k in parent_task},
        "id": bugfix_id,
        "parent_task_id": parent_task["id"],
        "title": f"Bugfix: Remediate CI failure in {parent_task['id']}: {regression.get('summary', '')}"[:120],
        "description": "\n".join(lines),
        "phase": parent_task.get("phase", "Continuous Polish & Evolution"),
        "status": "approved",
        "assigned_agent": parent_task.get("assigned_agent", "claude"),
        "verification_cmd": parent_task.get("verification_cmd", "npm run typecheck && npm test"),
        "target_branch": branch,
        "branch": branch,
        "base_branch": parent_task.get("base_branch", DEFAULT_BASE_BRANCH),
        "source_commit_sha": parent_task.get("commit_sha"),
        "regression_context": regression,
        "is_bugfix": True,
        "retry_count": 0,
        "github_issue_number": issue_num,
        "created_at": timestamp(),
    }


def extract_lines_from_diff(diff: str) -> list[tuple[str, int, str]]:
    """Extract (file_path, line_number, line_content) for added lines in a diff."""
    results: list[tuple[str, int, str]] = []
    current_file = "unknown"
    line_num = 1
    is_git_diff = "diff --git" in diff or "--- a/" in diff
    for raw_line in diff.splitlines():
        line = raw_line
        file_match = re.match(r"^diff --git a/(.+?) b/(.+?)$", line)
        if file_match:
            current_file = file_match.group(2)
            line_num = 1
            continue
        if line.startswith("+++ b/"):
            current_file = line[6:]
            continue
        hunk_match = re.match(r"^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@", line)
        if hunk_match:
            line_num = int(hunk_match.group(1))
            continue
        if is_git_diff:
            if line.startswith("+"):
                results.append((current_file, line_num, line[1:]))
                line_num += 1
            elif line.startswith(" "):
                line_num += 1
        else:
            results.append((current_file, line_num, line))
            line_num += 1
    return results


def evaluate_security_review(diff: str, files: list[str] | None = None,
                             agent: str = "security-agent") -> dict:
    findings = []
    lines = extract_lines_from_diff(diff)
    for file_path, line_num, line in lines:
        trimmed = line.strip()
        if not trimmed:
            continue

        if re.search(r"-----BEGIN[ A-Z0-9_-]*PRIVATE KEY-----", line, re.I):
            findings.append({
                "rule_id": "SEC-PRIVATE-KEY", "severity": "critical",
                "message": "Private encryption key embedded in source",
                "file": file_path, "line": line_num, "snippet": line[:100],
            })
        elif re.search(r"\b(?:sk-[a-zA-Z0-9]{20,}|gh[pousr]_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16})\b", line):
            findings.append({
                "rule_id": "SEC-TOKEN-LEAK", "severity": "critical",
                "message": "High-entropy API token or cloud credential detected",
                "file": file_path, "line": line_num, "snippet": line[:100],
            })
        elif (re.search(r"(?:api[_-]?key|secret|password|auth[_-]?token)\s*[:=]\s*['\"][A-Za-z0-9_-]{16,}['\"]", line, re.I)
              and "process.env" not in line):
            findings.append({
                "rule_id": "SEC-HARDCODED-SECRET", "severity": "critical",
                "message": "Hardcoded secret or authentication credential assignment detected",
                "file": file_path, "line": line_num, "snippet": line[:100],
            })

        if trimmed.startswith(("//", "#")):
            continue
        if re.search(r"\beval\s*\(", line):
            findings.append({
                "rule_id": "SEC-UNSAFE-EVAL", "severity": "critical",
                "message": "Unsafe eval() execution detected",
                "file": file_path, "line": line_num, "snippet": line[:100],
            })
        if (re.search(r"\bos\.system\s*\(", line) or
                re.search(r"\bsubprocess\.(?:call|Popen|run)\([^)]*shell\s*=\s*True", line)):
            findings.append({
                "rule_id": "SEC-SHELL-INJECTION", "severity": "critical",
                "message": "Unsafe subprocess invocation with shell=True or os.system",
                "file": file_path, "line": line_num, "snippet": line[:100],
            })
        if re.search(r"\bchild_process\b.*\bexec\s*\(", line):
            findings.append({
                "rule_id": "SEC-UNSAFE-EXEC", "severity": "error",
                "message": "Unquoted child_process.exec invocation",
                "file": file_path, "line": line_num, "snippet": line[:100],
            })

        if re.search(r"\bDROP\s+POLICY\b", line, re.I) or re.search(r"\bDISABLE\s+ROW\s+LEVEL\s+SECURITY\b", line, re.I):
            findings.append({
                "rule_id": "SEC-RLS-BYPASS", "severity": "critical",
                "message": "Tenant Row-Level Security bypass or policy drop detected",
                "file": file_path, "line": line_num, "snippet": line[:100],
            })

        if "../.." in line and "test" not in file_path.lower() and not trimmed.startswith(("import ", "export ")):
            findings.append({
                "rule_id": "SEC-PATH-TRAVERSAL", "severity": "error",
                "message": "Potential path traversal sequence (../../) in path resolution",
                "file": file_path, "line": line_num, "snippet": line[:100],
            })

    secret_locations = {(f["file"], f["line"]) for f in findings
                        if f["rule_id"] in {"SEC-PRIVATE-KEY", "SEC-TOKEN-LEAK", "SEC-HARDCODED-SECRET"}}
    for finding in findings:
        if (finding["file"], finding["line"]) in secret_locations:
            finding["snippet"] = "[REDACTED]"
    has_critical = any(f["severity"] == "critical" for f in findings)
    has_error = any(f["severity"] == "error" for f in findings)
    passed = not has_critical and not has_error
    score = 100 if not findings else (85 if passed else max(0, 100 - len(findings) * 35))
    summary = ("Security evaluation passed: no security vulnerabilities detected" if not findings
               else (f"Security evaluation passed with {len(findings)} warning(s)" if passed
                     else f"Security evaluation REJECTED: {len(findings)} security violation(s) detected"))
    return {
        "agent": agent,
        "role": "security",
        "decision": "approved" if passed else "rejected",
        "passed": passed,
        "score": score,
        "findings": findings,
        "summary": summary,
        "timestamp": timestamp(),
    }


def evaluate_lint_review(diff: str, files: list[str] | None = None,
                         agent: str = "lint-agent") -> dict:
    findings = []
    lines = extract_lines_from_diff(diff)
    for file_path, line_num, line in lines:
        trimmed = line.strip()
        if not trimmed or trimmed.startswith(("//", "#")):
            if re.search(r"(?:TODO|FIXME)\s*:\s*(?:BLOCKER|CRITICAL|SECURITY)", trimmed, re.I):
                findings.append({
                    "rule_id": "LINT-BLOCKER-COMMENT", "severity": "error",
                    "message": "Unresolved blocker or security TODO comment left in code",
                    "file": file_path, "line": line_num, "snippet": line[:100],
                })
            continue

        if re.search(r"\bdebugger\b", line):
            findings.append({
                "rule_id": "LINT-DEBUGGER", "severity": "error",
                "message": "Debugger statement found in code",
                "file": file_path, "line": line_num, "snippet": line[:100],
            })
        if re.search(r"\b(?:pdb\.set_trace|breakpoint)\s*\(", line):
            findings.append({
                "rule_id": "LINT-BREAKPOINT", "severity": "error",
                "message": "Python breakpoint statement found in code",
                "file": file_path, "line": line_num, "snippet": line[:100],
            })
        if re.search(r"\bconsole\.log\s*\(", line) and "test" not in file_path.lower() and "cli" not in file_path.lower():
            findings.append({
                "rule_id": "LINT-CONSOLE-LOG", "severity": "warning",
                "message": "console.log left in production code",
                "file": file_path, "line": line_num, "snippet": line[:100],
            })

    has_error = any(f["severity"] in ("error", "critical") for f in findings)
    passed = not has_error
    score = 100 if not findings else (90 if passed else max(0, 100 - len(findings) * 30))
    summary = ("Linting evaluation passed: clean code hygiene" if not findings
               else (f"Linting evaluation passed with {len(findings)} warning(s)" if passed
                     else f"Linting evaluation REJECTED: {len(findings)} lint violation(s) detected"))
    return {
        "agent": agent,
        "role": "lint",
        "decision": "approved" if passed else "rejected",
        "passed": passed,
        "score": score,
        "findings": findings,
        "summary": summary,
        "timestamp": timestamp(),
    }


def review_failure(agent: str, role: str, message: str) -> dict:
    return {
        "agent": agent, "role": role, "decision": "rejected", "passed": False,
        "findings": [{"rule_id": "REVIEW-ERROR", "severity": "critical", "message": message}],
        "summary": message, "timestamp": timestamp(),
    }


def valid_review(evaluation: object) -> bool:
    if not isinstance(evaluation, dict):
        return False
    return bool(
        isinstance(evaluation.get("agent"), str) and evaluation["agent"].strip()
        and evaluation.get("role") in ("security", "lint", "architecture", "general")
        and evaluation.get("decision") in ("approved", "rejected", "changes_requested")
        and type(evaluation.get("passed")) is bool
        and isinstance(evaluation.get("summary"), str)
        and isinstance(evaluation.get("timestamp"), str)
        and isinstance(evaluation.get("findings"), list)
        and all(isinstance(f, dict)
                and f.get("severity") in ("info", "warning", "error", "critical")
                and isinstance(f.get("rule_id"), str) and f["rule_id"]
                and isinstance(f.get("message"), str) and f["message"]
                for f in evaluation["findings"])
    )


def dispatch_parallel_reviews(diff: str, files: list[str] | None = None,
                              project_root: Path | None = None,
                              runner: Runner = run_cmd,
                              security_agent: str = "security-agent",
                              lint_agent: str = "lint-agent",
                              custom_evaluators: list[Callable] | None = None,
                              review_timeout: float = 30) -> list[dict]:
    """Read-only specialized reviewers, ordered results and one shared deadline.

    Daemon workers let a broken plugin time out without blocking process exit.
    Evaluators must be read-only: a timed-out Python callback cannot be killed.
    """
    if not math.isfinite(review_timeout) or review_timeout <= 0:
        raise ValueError("review_timeout must be positive and finite")
    evaluators = [
        (security_agent, "security", lambda: evaluate_security_review(diff, files, security_agent)),
        (lint_agent, "lint", lambda: evaluate_lint_review(diff, files, lint_agent)),
    ]
    evaluators.extend((f"custom-{i}", "general", fn)
                      for i, fn in enumerate(custom_evaluators or []))
    if len(evaluators) > 8:
        raise ValueError("At most eight review evaluators are supported")
    completed: Queue = Queue()
    results: dict[int, dict] = {}

    def evaluate(index: int, agent: str, role: str, fn: Callable) -> None:
        try:
            result = fn()
            if not valid_review(result) or result["role"] != role and role != "general":
                result = review_failure(agent, role, "Malformed review evaluation")
        except Exception:
            # Exception text can contain source or credentials; keep audit data safe.
            result = review_failure(agent, role, "Review evaluator raised an exception")
        completed.put((index, result))

    deadline = time.monotonic() + review_timeout
    for index, (agent, role, fn) in enumerate(evaluators):
        Thread(target=evaluate, args=(index, agent, role, fn), daemon=True).start()
    while len(results) < len(evaluators):
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            break
        try:
            index, result = completed.get(timeout=remaining)
            results[index] = result
        except Empty:
            break
    return [results.get(i) or review_failure(agent, role, "Review evaluation timed out")
            for i, (agent, role, _) in enumerate(evaluators)]


def evaluate_consensus_review_gate(evaluations: list[dict],
                                   min_approvals: int = 2,
                                   approval_threshold: float = 0.66,
                                   require_security: bool = True,
                                   require_lint: bool = True,
                                   block_on_critical: bool = True,
                                   block_on_error: bool = True,
                                   required_roles: tuple[str, ...] = ("security", "lint")) -> dict:
    if (type(min_approvals) is not int or min_approvals < 1
            or type(approval_threshold) not in (int, float)
            or not math.isfinite(approval_threshold) or not 0 <= approval_threshold <= 1
            or any(type(flag) is not bool for flag in
                   (require_security, require_lint, block_on_critical, block_on_error))
            or not isinstance(required_roles, (tuple, list))
            or any(role not in ("security", "lint", "architecture", "general") for role in required_roles)):
        raise ValueError("Invalid consensus review policy")
    violations: list[str] = []
    evaluations = [e if valid_review(e) else review_failure(
        f"invalid-{i}", "general", "Malformed review evaluation") for i, e in enumerate(evaluations)]
    agents = [e["agent"].strip().lower() for e in evaluations]
    if len(set(agents)) != len(agents):
        violations.append("Review agents must have distinct identities")
    if any(f["rule_id"] == "REVIEW-ERROR" for e in evaluations for f in e["findings"]):
        violations.append("Review evaluator failed or returned invalid evidence")
    approval_count = sum(1 for e in evaluations if e.get("passed") and e.get("decision") == "approved")
    rejection_count = sum(1 for e in evaluations if not e.get("passed") or e.get("decision") != "approved")
    total_evaluations = len(evaluations)

    evaluated_roles = {e.get("role") for e in evaluations}
    for role in required_roles:
        if role not in evaluated_roles:
            violations.append(f"Missing required review evaluation for role: '{role}'")
        elif not all(e["passed"] and e["decision"] == "approved" for e in evaluations if e["role"] == role):
            violations.append(f"Required review role rejected: '{role}'")

    security_gate_passed = True
    sec_evals = [e for e in evaluations if e.get("role") == "security"]
    if require_security:
        if not sec_evals:
            security_gate_passed = False
            violations.append("Security policy violated: no security evaluation provided")
        elif not all(e.get("passed") and e.get("decision") == "approved" for e in sec_evals):
            security_gate_passed = False
            violations.append("Security policy violated: security evaluation rejected or failed")
    if block_on_critical:
        if any(any(f.get("severity") == "critical" for f in e.get("findings", [])) for e in evaluations):
            security_gate_passed = False
            violations.append("Security policy violated: critical security finding detected")

    lint_gate_passed = True
    lint_evals = [e for e in evaluations if e.get("role") == "lint"]
    if require_lint:
        if not lint_evals:
            lint_gate_passed = False
            violations.append("Lint policy violated: no lint evaluation provided")
        elif not all(e.get("passed") and e.get("decision") == "approved" for e in lint_evals):
            lint_gate_passed = False
            violations.append("Lint policy violated: lint evaluation rejected or failed")
    if block_on_error:
        if any(any(f.get("severity") in ("error", "critical") for f in e.get("findings", [])) for e in evaluations):
            lint_gate_passed = False
            violations.append("Lint policy violated: error severity findings detected")

    if approval_count < min_approvals:
        violations.append(f"Consensus threshold not met: received {approval_count} approval(s), expected at least {min_approvals}")
    ratio = approval_count / total_evaluations if total_evaluations > 0 else 0
    if ratio < approval_threshold:
        violations.append(f"Consensus approval ratio not met: {ratio * 100:.1f}% < {approval_threshold * 100:.1f}%")

    consensus_reached = (
        approval_count >= min_approvals
        and ratio >= approval_threshold
        and not any(v.startswith("Consensus") for v in violations)
    )
    passed = consensus_reached and security_gate_passed and lint_gate_passed and not violations

    summary = (
        f"Consensus review gate PASSED ({approval_count}/{total_evaluations} approvals, security gate passed, lint gate passed)"
        if passed else
        f"Consensus review gate FAILED: {'; '.join(violations)}"
    )

    return {
        "passed": passed,
        "consensus_reached": consensus_reached,
        "security_gate_passed": security_gate_passed,
        "lint_gate_passed": lint_gate_passed,
        "approval_count": approval_count,
        "rejection_count": rejection_count,
        "total_evaluations": total_evaluations,
        "policy_violations": violations,
        "evaluations": evaluations,
        "summary": summary,
        "timestamp": timestamp(),
    }


MAX_HEALING_ATTEMPTS = 3
FAILED_CONCLUSIONS = {"FAILURE", "ERROR", "TIMED_OUT", "STARTUP_FAILURE", "CANCELLED", "ACTION_REQUIRED", "STALE"}


def fetch_ci_failure_logs(pr_number: int, project_root: Path, repo: str = DEFAULT_REPO,
                          runner: Runner = run_cmd, timeout: float = 60,
                          checks: list | None = None, head_sha: str | None = None) -> str:
    """Fetch only failed runs for the observed repository and immutable PR head.

    Explicit run IDs avoid gh's interactive run picker. All log reads share one
    deadline and a fixed run limit, so a worker tick never waits for CI.
    """
    parts = []
    for check in checks or []:
        if str(check.get("conclusion") or check.get("state") or "").upper() in FAILED_CONCLUSIONS:
            parts.append(f"Check {check.get('name') or check.get('context') or 'CI'} failed: "
                         f"{check.get('conclusion') or check.get('state')}\n"
                         f"{check.get('summary') or ''}\n{check.get('text') or ''}")
    deadline = time.monotonic() + min(timeout, 60)
    if head_sha:
        try:
            runs = _json(["gh", "run", "list", "--repo", repo, "--commit", head_sha,
                          "--limit", "10", "--json", "databaseId,headSha,conclusion,status"],
                         project_root, runner, max(0.01, deadline - time.monotonic()))
            selected = [run for run in runs if run.get("headSha") == head_sha
                        and str(run.get("conclusion", "")).upper() in FAILED_CONCLUSIONS
                        and isinstance(run.get("databaseId"), int)][:3]
            for run in selected:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    break
                code, out = runner(["gh", "run", "view", str(run["databaseId"]),
                                    "--repo", repo, "--log-failed"], remaining, project_root)
                if code == 0 and out.strip():
                    parts.append(out[-16000:])
        except (ValueError, TypeError, KeyError, AttributeError, OSError):
            pass  # Legacy/external checks may have no Actions logs.
    return "\n\n".join(parts)[-64000:] or f"CI failed for PR #{pr_number} at {head_sha}"


def trigger_self_healing(task: dict, project_root: Path, regression: dict,
                         runner: Runner = run_cmd) -> dict | None:
    bugfix = None

    def apply(data: dict) -> bool:
        nonlocal bugfix
        parent = next((t for t in data["tasks"] if t["id"] == task["id"]), None)
        if (not parent or not _verified(parent)
                or any(parent.get(k) != task.get(k) for k in EVIDENCE_FIELDS)):
            return False
        if parent.get("is_bugfix"):
            try:
                repair_parent(parent, data["tasks"])
            except ValueError:
                return False
        if parent.get("is_bugfix") and parent.get("commit_sha") == parent.get("source_commit_sha"):
            return False  # No code change: do not regenerate the same failed head.
        # One remediation per verified head, even after an agent fails or a retry
        # races this poll. A new attempt requires a newly verified/published head.
        existing = next((t for t in data["tasks"] if t.get("parent_task_id") == parent["id"]
                         and t.get("is_bugfix") and t.get("source_commit_sha") == parent.get("commit_sha")), None)
        if existing:
            bugfix = existing
            return False
        depth, ancestor = 0, parent
        while ancestor.get("is_bugfix"):
            depth += 1
            ancestor = next((t for t in data["tasks"] if t["id"] == ancestor.get("parent_task_id")), {})
            if depth >= MAX_HEALING_ATTEMPTS:
                return False
        bugfix = create_bugfix_task(parent, regression, parent["branch"], [t["id"] for t in data["tasks"]])
        data["tasks"].append(bugfix)
        parent.update(bugfix_task_id=bugfix["id"], regression_analysis=regression)
        record_sync_history(data, parent, {
            "timestamp": timestamp(), "task_id": parent["id"],
            "action": "self_healing_bugfix_generated", "bugfix_task_id": bugfix["id"],
            "message": f"Generated {bugfix['id']} for {parent['commit_sha']}: {regression.get('summary', '')}",
        })
        return True

    changed = roadmap_store.update_roadmap(project_root / "ROADMAP.json", apply)
    if changed and bugfix:
        build_events.emit(project_root, task["id"], "orchestrator", f"Generated CI repair {bugfix['id']}")
    return bugfix


def _reconcile(task: dict, root: Path, repo: str, runner: Runner, timeout: float,
               auto_merge: bool = True, review_timeout: float = 30,
               review_policy: dict | None = None) -> tuple[bool, dict]:
    ci = check_pr_ci_status(task["pr_number"], root, repo, runner, timeout)
    info = ci.get("pr", {})
    fields = {"ci_status": ci["status"], "pr_status": f"ci_{ci['status']}"}
    error = ci.get("error")
    matches = (info.get("headRefName") == task["branch"]
               and info.get("baseRefName") == task["base_branch"]
               and info.get("headRefOid") == task["commit_sha"])
    if info and not matches:
        error = "PR head or base differs from the verified publication"
        fields.update(ci_status="unknown", pr_status="ci_unknown")
    elif info.get("state") == "CLOSED":
        fields["pr_status"] = "closed"
    elif info.get("state") == "OPEN" and ci["status"] == "failed":
        regression = task.get("regression_analysis")
        if not regression or regression.get("source_commit_sha") != task["commit_sha"]:
            logs = fetch_ci_failure_logs(task["pr_number"], root, repo, runner, timeout,
                                         checks=info.get("statusCheckRollup"), head_sha=task["commit_sha"])
            regression = {**parse_ci_error_logs(logs), "source_commit_sha": task["commit_sha"],
                          "pr_number": task["pr_number"]}
        bugfix = trigger_self_healing(task, root, regression, runner)
        fields["regression_analysis"] = regression
        fields["self_healing_status"] = bugfix["status"] if bugfix else "exhausted"
        if bugfix:
            fields["bugfix_task_id"] = bugfix["id"]
    elif (info.get("state") == "OPEN" and ci["status"] == "passed" and auto_merge
          and not info.get("isDraft", True) and info.get("mergeStateStatus") == "CLEAN"
          and info.get("reviewDecision") not in ("CHANGES_REQUESTED", "REVIEW_REQUIRED")):
        if not _current(root, task):
            return False, {"error": "Task changed before merge"}
        diff_code, diff_out = runner(["gh", "pr", "diff", str(task["pr_number"]), "--repo", repo], timeout, root)
        # The transport captures a bounded tail. Never approve missing, truncated
        # or uninspectable content, and never fall back to a stale local base.
        if (diff_code or not diff_out.startswith("diff --git ")
                or len(diff_out.encode("utf-8")) >= OUTPUT_LIMIT
                or re.search(r"(?m)^(?:GIT binary patch|Binary files .* differ)$", diff_out)):
            evaluations = [review_failure("diff-reader", "security", "PR diff unavailable, truncated or uninspectable")]
        else:
            evaluations = dispatch_parallel_reviews(diff_out, project_root=root, runner=runner,
                                                    review_timeout=review_timeout)
        consensus = evaluate_consensus_review_gate(evaluations, **(review_policy or {}))
        consensus.update(head_sha=task["commit_sha"], base_sha=info.get("baseRefOid"))
        fields["consensus_review"] = consensus
        fields["security_gate_status"] = "passed" if consensus["security_gate_passed"] else "failed"
        fields["review_status"] = "approved" if consensus["passed"] else "changes_requested"
        if not consensus["passed"]:
            error = f"Multi-agent review gate rejected PR: {consensus['summary']}"
            fields["publication_error"] = error
            build_events.emit(root, task["id"], "consensus_review", f"Review gate failed: {consensus['summary']}")
        else:
            # Reviews may take time: revalidate live task, head, base, CI and
            # branch rules immediately before the merge request.
            observed = check_pr_ci_status(task["pr_number"], root, repo, runner, timeout)
            fresh = observed.get("pr", {})
            unchanged = all(fresh.get(k) == info.get(k) for k in
                            ("headRefOid", "headRefName", "baseRefName", "baseRefOid"))
            ready = (fresh.get("state") == "OPEN" and not fresh.get("isDraft", True)
                     and observed["status"] == "passed" and fresh.get("mergeStateStatus") == "CLEAN"
                     and fresh.get("reviewDecision") not in ("CHANGES_REQUESTED", "REVIEW_REQUIRED"))
            if not unchanged or not ready or not _current(root, task):
                error = "PR or task changed during consensus review; merge deferred"
                fields.update(ci_status="unknown", review_status="pending")
            else:
                if not _record(root, task, **fields):
                    return False, {"error": "Task changed before recording consensus review"}
                build_events.emit(root, task["id"], "consensus_review", f"Review gate passed: {consensus['summary']}")
                code, out = runner(["gh", "pr", "merge", str(task["pr_number"]), "--repo", repo,
                                    "--merge", "--delete-branch", "--match-head-commit", task["commit_sha"]],
                                   timeout, root)
                if code:
                    error = f"Merge failed ({code}): {out}"
                # Exit zero can mean queued, so completion requires GitHub's merged state.
                observed = check_pr_ci_status(task["pr_number"], root, repo, runner, timeout)
                info = observed.get("pr", {})
    matches = (info.get("headRefName") == task["branch"]
               and info.get("baseRefName") == task["base_branch"]
               and info.get("headRefOid") == task["commit_sha"])
    if matches and info.get("state") == "MERGED":
        merge_sha = (info.get("mergeCommit") or {}).get("oid")
        if merge_sha and info.get("mergedAt"):
            fields.update(status="completed", pr_status="merged", merge_commit_sha=merge_sha,
                          completed_at=info["mergedAt"], merged_at=info["mergedAt"])
            error = None
    fields["publication_error"] = error
    if not _record(root, task, **fields):
        return False, {"error": "Task changed while reconciling PR"}
    return True, {"pr_number": task["pr_number"], "pr_status": fields["pr_status"],
                  "merged": fields["pr_status"] == "merged", "error": error,
                  "bugfix_task_id": fields.get("bugfix_task_id"),
                  "regression_analysis": fields.get("regression_analysis"),
                  "consensus_review": fields.get("consensus_review"),
                  "security_gate_status": fields.get("security_gate_status"),
                  "review_status": fields.get("review_status")}



def run_pr_lifecycle_for_verified_task(task: dict, project_root: Path,
        repo: str = DEFAULT_REPO, remote: str = DEFAULT_REMOTE,
        base_branch: str = DEFAULT_BASE_BRANCH, auto_merge_if_ci_passes: bool = True,
        maintainers_data: dict | None = None, runner: Runner = run_cmd,
        timeout: float = 120, review_timeout: float = 30,
        review_policy: dict | None = None) -> tuple[bool, dict]:
    with _lock(project_root) as acquired:
        if not acquired:
            return False, {"error": "PR lifecycle is busy"}
        data = json.loads((project_root / "ROADMAP.json").read_text(encoding="utf-8"))
        if data.get("current_task_id") not in (None, task["id"]):
            return False, {"error": "Another task owns the checkout"}
        task = _load_task(project_root, task["id"])
        if not _verified(task):
            return False, {"error": "Task lacks successful current verification evidence"}
        try:
            evaluate_consensus_review_gate([], **(review_policy or {}))
            if not math.isfinite(review_timeout) or review_timeout <= 0:
                raise ValueError("review_timeout must be positive and finite")
            if task.get("pr_number"):
                if task.get("published_evidence") != publication_evidence(task):
                    raise ValueError("Verification or requirements changed since PR publication")
                code, current = runner(["git", "branch", "--show-current"], timeout, project_root)
                if code:
                    raise ValueError(current)
                if current.strip() == task["branch"]:
                    code, out = runner(["git", "checkout", task["base_branch"]], timeout, project_root)
                    if code:
                        raise ValueError(f"Cannot return to base branch: {out}")
                return _reconcile(task, project_root, repo, runner, timeout, auto_merge_if_ci_passes,
                                  review_timeout, review_policy)
            if task.get("is_bugfix"):
                parent = repair_parent(task, json.loads((project_root / "ROADMAP.json").read_text())["tasks"])
                observed = check_pr_ci_status(parent["pr_number"], project_root, repo, runner, timeout).get("pr", {})
                code, current = runner(["git", "branch", "--show-current"], timeout, project_root)
                if (code or current.strip() != task["branch"] or observed.get("state") != "OPEN"
                        or observed.get("headRefOid") not in {task["source_commit_sha"], task.get("repair_commit_sha")}
                        or observed.get("headRefName") != task["branch"]
                        or observed.get("baseRefName") != parent["base_branch"]):
                    raise ValueError("CI repair checkout or PR changed before publication")
                # The ordinary commit/push path below reuses this branch and PR.
            # Validate configuration before any Git mutation.
            build_pr_metadata(task, maintainers_data, project_root, base_branch)
            branch = get_task_branch_name(task)
            ok, detail = create_and_checkout_branch(branch, project_root, base_branch, runner, timeout)
            if not ok:
                raise ValueError(detail)
            if not _current(project_root, task):
                return False, {"error": "Task changed before commit"}
            ok, sha = commit_task_changes(task, project_root, runner, timeout)
            if not ok:
                raise ValueError(sha)
            if task.get("is_bugfix"):
                if not _record(project_root, task, release_checkout=False, repair_commit_sha=sha):
                    return False, {"error": "Task changed before repair checkpoint"}
                task = _load_task(project_root, task["id"])
            if not _current(project_root, task):
                return False, {"error": "Task changed before push"}
            code, out = runner(["git", "push", "-u", remote, f"{sha}:refs/heads/{branch}"], timeout, project_root)
            if code:
                raise ValueError(f"git push failed ({code}): {out}")
            if not _current(project_root, task):
                return False, {"error": "Task changed before PR creation"}
            if task.get("is_bugfix"):
                # The parent already owns this PR. Updating its branch is enough;
                # never create a second PR or change its issue-closing metadata.
                result = {"pr_number": parent["pr_number"], "pr_url": parent.get("pr_url"),
                          "reviewers": parent.get("reviewers", [])}
            else:
                ok, result = create_pull_request({**task, "branch": branch}, project_root, repo,
                                                 base_branch, maintainers_data, runner, timeout)
                if not ok:
                    raise ValueError(result["error"])
            if not _record(project_root, task, **result, branch=branch, base_branch=base_branch,
                           commit_sha=sha, pr_status="open", publication_error=None,
                           published_evidence=publication_evidence(task)):
                return False, {"error": "Task changed during PR creation"}
            task = _load_task(project_root, task["id"])
            # Return to base with runtime state intact; no reset, stash or force.
            code, out = runner(["git", "checkout", base_branch], timeout, project_root)
            if code:
                raise ValueError(f"Cannot return to base branch: {out}")
            build_events.emit(project_root, task["id"], "pr_lifecycle", f"Published PR #{result['pr_number']}")
            task = _load_task(project_root, task["id"])
            return _reconcile(task, project_root, repo, runner, timeout, auto_merge_if_ci_passes,
                                  review_timeout, review_policy)
        except (ValueError, OSError, TypeError, KeyError) as error:
            _record(project_root, task, publication_error=str(error))
            return False, {"error": str(error)}


def scan_and_merge_prs(project_root: Path, repo: str = DEFAULT_REPO,
                        runner: Runner = run_cmd, timeout: float = 120) -> list[str]:
    data = json.loads((project_root / "ROADMAP.json").read_text(encoding="utf-8"))
    merged = []
    for task in data["tasks"]:
        if _verified(task) and task.get("pr_number") and task.get("pr_status") != "closed":
            ok, result = run_pr_lifecycle_for_verified_task(task, project_root, repo, runner=runner, timeout=timeout)
            if ok and result.get("merged"):
                merged.append(task["id"])
    return merged


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("task_id", nargs="?")
    parser.add_argument("--scan-and-merge", action="store_true")
    parser.add_argument("--project-root", type=Path, default=PROJECT_ROOT)
    parser.add_argument("--repo", default=DEFAULT_REPO)
    parser.add_argument("--remote", default=DEFAULT_REMOTE)
    parser.add_argument("--base-branch", default=DEFAULT_BASE_BRANCH)
    args = parser.parse_args()
    root = args.project_root.resolve()
    if args.scan_and_merge:
        print(json.dumps({"merged_tasks": scan_and_merge_prs(root, args.repo)}))
    elif args.task_id:
        ok, result = run_pr_lifecycle_for_verified_task({"id": args.task_id}, root,
            args.repo, args.remote, args.base_branch)
        print(json.dumps(result))
        raise SystemExit(0 if ok else 1)
    else:
        parser.error("Provide task_id or --scan-and-merge")


if __name__ == "__main__":
    main()
