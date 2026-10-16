#!/usr/bin/env python3
"""Trusted repository worker: approved roadmap -> agent -> verification -> Git.

This is the repository automation entry point used by watchdog.sh. It is separate
from the tenant-scoped API/sandbox runtime; never feed it untrusted tenant input.
"""

from __future__ import annotations

import argparse
import fcntl
import json
import re
import signal
import time
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable, Literal

import build_events
import roadmap_store
import pr_lifecycle
import roadmap_sync
import verify_task
from command_runner import OUTPUT_LIMIT, run_cmd
from issue_lifecycle import (
    IGNORED_LABELS, issue_number_for_task, label_names, mark_issue_closed,
)

PROJECT_ROOT = Path(__file__).resolve().parent
REPO = "moslembabaee/software-factory"
AGENT_CHAIN = ("claude", "codex", "antigravity")


@dataclass(frozen=True)
class RuntimeConfig:
    project_root: Path = PROJECT_ROOT
    repo: str = REPO
    remote: str = "origin"
    branch: str = "main"
    agent_timeout: float = 720
    verification_timeout: float = 300
    git_timeout: float = 120
    review_timeout: float = 30
    review_min_approvals: int = 2
    review_approval_threshold: float = 0.66
    poll_seconds: float = 5

    @property
    def roadmap_file(self) -> Path:
        return self.project_root / "ROADMAP.json"

    @property
    def review_policy(self) -> dict:
        return {"min_approvals": self.review_min_approvals,
                "approval_threshold": self.review_approval_threshold}


@dataclass(frozen=True)
class Attempt:
    agent: str
    timestamp: str
    exit_code: int
    verification_exit_code: int | None
    failure: Literal["quota", "agent", "verification"] | None
    log_tail: str


def timestamp() -> str:
    return datetime.now(timezone.utc).isoformat()


def log(config: RuntimeConfig, message: str, task_id: str | None = None) -> None:
    directory = config.project_root / "logs"
    directory.mkdir(exist_ok=True)
    line = f"[{timestamp()}] {message}"
    print(line, flush=True)
    with (directory / "orchestrator.log").open("a", encoding="utf-8") as output:
        output.write(line + "\n")
    if task_id:
        build_events.emit(config.project_root, task_id, "orchestrator", message)


def agent_order(assigned_agent: str) -> tuple[str, ...]:
    index = AGENT_CHAIN.index(assigned_agent) if assigned_agent in AGENT_CHAIN else 0
    return AGENT_CHAIN[index:] + AGENT_CHAIN[:index]


def execute_agent_task(
    agent: str, prompt: str, config: RuntimeConfig,
) -> tuple[int, str]:
    commands = {
        "claude": ["env", "CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT=1",
                   "claude", "-p", prompt, "--max-turns", "40"],
        "codex": ["codex", "exec", "--sandbox", "workspace-write", "-c",
                  'model_reasoning_effort="high"', prompt],
        "antigravity": ["agy", "-p", prompt, "--model", "gemini-3.8-flash-high",
                        "--dangerously-skip-permissions", "--print-timeout", "12m"],
    }
    if agent not in commands:
        return -2, f"Unknown agent: {agent}"
    return run_cmd(commands[agent], config.agent_timeout, config.project_root)


def quota_error(output: str) -> bool:
    # Some CLI versions print a provider error but exit zero. Match error records,
    # rather than an ordinary explanation mentioning a rate limit.
    return bool(re.search(
        r"(?im)^\s*(?:AGY_ERROR:.*(?:RESOURCE_EXHAUSTED|429)|"
        r"error:.*(?:quota|RESOURCE_EXHAUSTED|rate.limit)|"
        r'\{[^\n]*"(?:status|error_code)"\s*:\s*(?:"RESOURCE_EXHAUSTED"|429))',
        output,
    ))


def build_prompt(task: dict, config: RuntimeConfig, feedback: str | None = None) -> str:
    prompt = f"""We are building 'Software Factory', an autonomous software generation platform.
Project directory: {config.project_root}
Repository: {config.repo}
Task ID: {task['id']}
Phase: {task.get('phase', '')}
Title: {task['title']}
Description: {task['description']}

Implement all necessary code, types, and tests in the project directory.
Follow existing patterns: Fastify API, TypeScript strict, PostgreSQL with RLS.
Verify with: {task['verification_cmd']}
Leave Git commits, pushes, and roadmap lifecycle updates to the orchestrator.
"""
    if feedback:
        prompt += f"\nPrevious attempt failed. Fix any implementation failure below.\n{feedback[-4000:]}\n"
    if task.get("regression_context"):
        ctx = task["regression_context"]
        prompt += (f"\nRepair the existing PR on branch {task.get('target_branch', '')} "
                   f"at failing commit {task.get('source_commit_sha', '')}. "
                   "Reproduce the reported failure, make a focused fix, and add or update a regression test. "
                   "Run the full verification command; preserve the existing quality gates.\n")
        prompt += f"\nCI Failure Regression Context:\nSummary: {ctx.get('summary', '')}\n"
        if ctx.get("failing_tests"):
            prompt += "Failing Tests:\n" + "\n".join(f"- {t}" for t in ctx["failing_tests"]) + "\n"
        if ctx.get("error_messages"):
            prompt += "Errors:\n" + "\n".join(f"- {e}" for e in ctx["error_messages"]) + "\n"
        if ctx.get("failing_files"):
            prompt += "Implicated Files:\n" + "\n".join(f"- {f}" for f in ctx["failing_files"]) + "\n"
        if ctx.get("stack_traces"):
            prompt += "Stack traces:\n" + "\n".join(ctx["stack_traces"][:3])[:6000] + "\n"
        elif ctx.get("raw_log_tail"):
            prompt += "CI log tail:\n" + ctx["raw_log_tail"][-4000:] + "\n"
    return prompt


class AgentRuntime:
    def __init__(self, config: RuntimeConfig = RuntimeConfig()):
        self.config = config

    def load(self) -> dict:
        return json.loads(self.config.roadmap_file.read_text(encoding="utf-8"))

    def update(
        self, task_id: str, change: Callable[[dict, dict], None],
        statuses: tuple[str, ...] = ("in_progress",),
    ) -> bool:
        """Mutate only the current live task, never overwrite a concurrent writer."""
        def apply(data: dict) -> bool:
            task = next((t for t in data["tasks"] if t["id"] == task_id), None)
            if (not task or task.get("closed_at") or
                    task.get("status") not in statuses or
                    data.get("current_task_id") != task_id):
                return False
            change(task, data)
            return True
        return roadmap_store.update_roadmap(self.config.roadmap_file, apply)

    def eligible(self, task: dict) -> bool:
        backoff_until = task.get("backoff_until")
        if backoff_until:
            try:
                dt = datetime.fromisoformat(str(backoff_until).replace("Z", "+00:00"))
                if dt.tzinfo is None:
                    dt = dt.replace(tzinfo=timezone.utc)
                if datetime.now(timezone.utc) < dt:
                    return False
            except (ValueError, TypeError):
                pass
        number = issue_number_for_task(task)
        if not number:
            return True
        code, output = run_cmd(
            ["gh", "issue", "view", str(number), "--repo", self.config.repo,
             "--json", "state,labels,closedAt"], 30, self.config.project_root,
        )
        if code:
            log(self.config, f"Deferring {task['id']}: cannot confirm issue eligibility")
            return False
        try:
            issue = json.loads(output)
            if issue["state"].upper() == "CLOSED":
                def close(data: dict) -> bool:
                    return mark_issue_closed(data, number, issue.get("closedAt"))
                roadmap_store.update_roadmap(self.config.roadmap_file, close)
                return False
            if label_names(issue) & IGNORED_LABELS:
                return False
            return issue["state"].upper() == "OPEN"
        except (ValueError, KeyError, TypeError, AttributeError):
            log(self.config, f"Deferring {task['id']}: invalid issue response")
            return False

    def claim(self, *, bugfix_only: bool = False) -> dict | None:
        data = self.load()
        if data.get("current_task_id"):
            return None  # Crash recovery is explicit; do not steal another task.
        for candidate in sorted(data["tasks"], key=lambda t: not t.get("is_bugfix", False)):
            if bugfix_only and not candidate.get("is_bugfix"):
                continue
            if (candidate.get("status") != "approved" or
                    candidate.get("closed_at") or not self.eligible(candidate)):
                continue
            # Before another implementation, bring base forward to the merged PR.
            # Control files are excluded from PR commits, so their live edits stay.
            if not candidate.get("is_bugfix") and any(t.get("pr_status") == "merged" for t in data["tasks"]):
                for command in (["git", "checkout", self.config.branch],
                                ["git", "fetch", "--no-tags", self.config.remote, self.config.branch],
                                ["git", "merge", "--ff-only", "FETCH_HEAD"]):
                    code, output = run_cmd(command, self.config.git_timeout, self.config.project_root)
                    if code:
                        log(self.config, f"Deferring {candidate['id']}: cannot update base: {output}")
                        return None
            claimed = None

            def apply(latest: dict) -> bool:
                nonlocal claimed
                if latest.get("current_task_id"):
                    return False
                task = next((t for t in latest["tasks"] if t["id"] == candidate["id"]), None)
                if not task or task.get("status") != "approved" or task.get("closed_at"):
                    return False
                task["status"] = "in_progress"
                task["started_at"] = timestamp()
                latest["current_task_id"] = task["id"]
                claimed = dict(task)
                return True

            if roadmap_store.update_roadmap(self.config.roadmap_file, apply):
                return claimed
        return None

    def finish(self, task_id: str, status: str, **fields: object) -> bool:
        def apply(task: dict, data: dict) -> None:
            task.update(fields)
            task["status"] = status
            data["current_task_id"] = None
        return self.update(task_id, apply, ("in_progress", "verified"))

    def publish(self, task: dict) -> tuple[bool, str]:
        success, result = pr_lifecycle.run_pr_lifecycle_for_verified_task(
            task, self.config.project_root, repo=self.config.repo,
            remote=self.config.remote, base_branch=self.config.branch,
            runner=run_cmd, timeout=self.config.git_timeout,
            review_timeout=self.config.review_timeout, review_policy=self.config.review_policy,
        )
        return success, str(result.get("error") or result.get("pr_status", "open"))

    def evaluate_review_gate(self, diff: str, files: list[str] | None = None) -> dict:
        evaluations = pr_lifecycle.dispatch_parallel_reviews(
            diff, files, self.config.project_root, run_cmd, review_timeout=self.config.review_timeout)
        return pr_lifecycle.evaluate_consensus_review_gate(evaluations, **self.config.review_policy)

    def publish_verified(self, task: dict) -> str:
        success, detail = self.publish(task)
        if not success:
            # Keep successful verification for a publication retry on the next tick.
            self.update(task["id"], lambda current, data: (
                current.update(publication_error=detail), data.update(current_task_id=None)
            ), ("verified",))
            log(self.config, f"{task['id']}: {detail}", task["id"])
            return "failed"
        latest = next(t for t in self.load()["tasks"] if t["id"] == task["id"])
        if latest.get("consensus_review"):
            log(self.config, f"{task['id']}: {latest['consensus_review'].get('summary', '')}", task["id"])
        return "completed" if latest["status"] == "completed" else "ci_pending"

    def execute(self, task: dict) -> str:
        task_id = task["id"]
        verification = task.get("verification_cmd")
        if not isinstance(verification, str) or not verification.strip():
            self.finish(task_id, "failed", last_error="Missing verification_cmd; dispatch refused")
            return "failed"
        if task.get("is_bugfix"):
            # Repairs must run on the failing implementation, not the base branch.
            try:
                parent = pr_lifecycle.repair_parent(task, self.load()["tasks"])
            except ValueError as error:
                self.finish(task_id, "failed", last_error=str(error))
                return "failed"
            info = pr_lifecycle.check_pr_ci_status(parent.get("pr_number"), self.config.project_root,
                self.config.repo, run_cmd, self.config.git_timeout).get("pr", {})
            if (info.get("state") != "OPEN" or info.get("headRefOid") != task.get("source_commit_sha")
                    or info.get("headRefName") != task.get("target_branch")
                    or info.get("baseRefName") != parent.get("base_branch")):
                self.finish(task_id, "failed", last_error="CI repair parent or PR changed before dispatch")
                return "failed"
            for command in (["git", "checkout", task["target_branch"]], ["git", "rev-parse", "HEAD"]):
                code, output = run_cmd(command, self.config.git_timeout, self.config.project_root)
                if code or (command[1] == "rev-parse" and output.strip() != task["source_commit_sha"]):
                    self.finish(task_id, "failed", last_error=f"CI repair checkout differs from failing head: {output}")
                    return "failed"
        feedback = None
        for agent in agent_order(task.get("assigned_agent", "claude")):
            if not self.update(task_id, lambda _task, _data: None):
                return "cancelled"
            log(self.config, f"Dispatching {task_id} to {agent}", task_id)
            code, output = execute_agent_task(agent, build_prompt(task, self.config, feedback), self.config)
            failure = "quota" if quota_error(output) else ("agent" if code else None)
            verify_code = None
            if not self.update(task_id, lambda _task, _data: None,
                               ("in_progress", "ready_for_verification")):
                return "cancelled"
            if failure is None:
                log(self.config, f"Verifying {task_id}: {verification}", task_id)
                def ready(current: dict, _data: dict) -> None:
                    current["status"] = "ready_for_verification"
                if not self.update(task_id, ready, ("in_progress", "ready_for_verification")):
                    return "cancelled"
                result = verify_task.verify_task(
                    task_id, self.config.project_root,
                    timeout=self.config.verification_timeout, runner=run_cmd,
                )
                if result.outcome not in {"verified", "failed"}:
                    return result.outcome
                verify_code, output = result.exit_code, result.log_tail
                if result.outcome == "failed":
                    failure = "verification"
            attempt = Attempt(agent, timestamp(), code, verify_code, failure, output[-4000:])

            def record(current: dict, _data: dict) -> None:
                current.setdefault("attempts", []).append(asdict(attempt))
                if failure:
                    # Verification failures already incremented in the executor.
                    if failure != "verification":
                        current["retry_count"] = current.get("retry_count", 0) + 1
                    current["last_error"] = f"{agent}: {failure}\n{output[-4000:]}"

            if not self.update(task_id, record, ("in_progress", "verified")):
                return "cancelled"
            if failure:
                feedback = f"{agent}: {failure}\n{output[-4000:]}"
                log(self.config, f"{task_id}: {agent} failed ({failure}); advancing failover chain", task_id)
                continue
            if not self.update(task_id, lambda current, _data: current.update(
                    completed_agent=agent, last_error=None), ("verified",)):
                return "cancelled"
            return self.publish_verified(task)
        self.finish(task_id, "failed")
        return "failed"

    def run_once(self) -> str:
        directory = self.config.project_root / "logs"
        directory.mkdir(exist_ok=True)
        with (directory / "orchestrator.lock").open("a") as lock:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                return "busy"
            if (self.config.project_root / "STOP_IMPROVEMENTS").exists():
                return "stopped"
            data = self.load()
            current = data.get("current_task_id")
            repairing = {t["parent_task_id"] for t in data["tasks"] if t.get("is_bugfix")
                         and not t.get("closed_at") and t.get("status") not in ("completed", "cancelled")}
            verified = next((t for t in sorted(data["tasks"], key=lambda t: not t.get("is_bugfix", False))
                             if t.get("status") == "verified" and not t.get("closed_at")
                             and t.get("pr_status") != "closed" and t["id"] not in repairing
                             and current in (None, t["id"])), None)
            task = next((t for t in data["tasks"]
                         if t.get("status") == "ready_for_verification"
                         and not t.get("closed_at") and current in (None, t["id"])
                         and not verify_task.skip_recorded(t) and self.eligible(t)), None)
            verification_only = task is not None
            priority_fix = None
            if (current is None and not (verified and verified.get("is_bugfix"))
                    and any(t.get("is_bugfix") and t.get("status") == "approved"
                            and not t.get("closed_at") for t in data["tasks"])):
                priority_fix = self.claim(bugfix_only=True)
            if priority_fix is not None:
                task, verified, verification_only = priority_fix, None, False
            elif verified is not None:
                task = verified
            elif task is None:
                task = self.claim()
            if task is None:
                return "idle"
            try:
                if verified is not None:
                    return self.publish_verified(verified)
                if verification_only:
                    result = verify_task.verify_task(
                        task["id"], self.config.project_root,
                        timeout=self.config.verification_timeout, runner=run_cmd,
                    )
                    log(self.config, f"Verification {task['id']}: {result.outcome} {result.note}", task["id"])
                    if result.outcome == "verified":
                        return self.publish_verified(task)
                    return result.outcome
                return self.execute(task)
            except Exception as error:
                self.finish(task["id"], "failed", last_error=f"Runtime error: {error}")
                log(self.config, f"{task['id']}: runtime error: {error}", task["id"])
                return "failed"
            finally:
                # Only render local markdown; this never posts GitHub messages.
                data = self.load()
                (self.config.project_root / "ROADMAP.md").write_text(
                    roadmap_sync.generate_roadmap_markdown(data), encoding="utf-8",
                )


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--once", action="store_true", help="Process at most one approved or ready task")
    parser.add_argument("--project-root", type=Path, default=PROJECT_ROOT)
    parser.add_argument("--repo", default=REPO)
    parser.add_argument("--remote", default="origin")
    parser.add_argument("--branch", default="main")
    args = parser.parse_args()
    runtime = AgentRuntime(RuntimeConfig(
        project_root=args.project_root.resolve(), repo=args.repo,
        remote=args.remote, branch=args.branch,
    ))
    def stop(_signum: int, _frame: object) -> None:
        # Let run_cmd terminate its active process group before exiting.
        raise KeyboardInterrupt

    signal.signal(signal.SIGTERM, stop)
    try:
        while True:
            outcome = runtime.run_once()
            if args.once:
                raise SystemExit(1 if outcome == "failed" else 0)
            if outcome == "stopped":
                return
            time.sleep(runtime.config.poll_seconds)
    except KeyboardInterrupt:
        return


if __name__ == "__main__":
    main()
