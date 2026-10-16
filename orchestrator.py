#!/usr/bin/env python3
"""Trusted repository worker: approved roadmap -> agent -> verification -> Git.

This is the repository automation entry point used by watchdog.sh. It is separate
from the tenant-scoped API/sandbox runtime; never feed it untrusted tenant input.
"""

from __future__ import annotations

import argparse
import fcntl
import json
import math
import re
import signal
import time
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable, Literal

import build_events
import runtime_telemetry as telemetry
import failure_analysis
import roadmap_store
import pr_lifecycle
import roadmap_sync
import verify_task
import verification_remediation as remediation
from command_runner import OUTPUT_LIMIT, run_cmd, run_cmd_split
from issue_lifecycle import (
    IGNORED_LABELS, issue_number_for_task, label_names, mark_issue_closed,
)

PROJECT_ROOT = Path(__file__).resolve().parent
REPO = "moslembabaee/software-factory"
AGENT_CHAIN = ("claude", "codex", "antigravity")

AGENT_RATES = telemetry.AGENT_RATES

ReflectionEngine = failure_analysis.ReflectionEngine
FailureAnalysis = failure_analysis.FailureAnalysis
FailureDiagnostic = failure_analysis.FailureDiagnostic
analyze_failure = failure_analysis.analyze_failure
synthesize_remediation_prompt = failure_analysis.synthesize_remediation_prompt
generate_failure_summary = failure_analysis.generate_failure_summary
reflection_engine = failure_analysis._default_engine


@dataclass(frozen=True)
class RuntimeConfig:
    project_root: Path = PROJECT_ROOT
    repo: str = REPO
    remote: str = "origin"
    branch: str = "main"
    agent_timeout: float = 960
    verification_timeout: float = 600
    git_timeout: float = 120
    review_timeout: float = 30
    review_min_approvals: int = 2
    review_approval_threshold: float = 0.66
    poll_seconds: float = 5
    default_budget_cap_usd: float | None = None
    token_rates: dict[str, dict[str, float]] | None = None

    def __post_init__(self) -> None:
        if not math.isfinite(self.agent_timeout) or self.agent_timeout <= 0:
            raise ValueError("agent_timeout must be finite and positive")
        telemetry.budget_cap({}, self.default_budget_cap_usd)
        for rates in (self.token_rates or AGENT_RATES).values():
            for key in ("prompt", "completion"):
                if telemetry.nonnegative(rates.get(key), None) is None:
                    raise ValueError("Token rates must be finite and nonnegative")

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
    failure: Literal["quota", "agent", "verification", "budget_exceeded", "timeout", "runtime"] | None
    log_tail: str
    duration_seconds: float = 0.0
    tokens: dict | None = None
    cost_usd: float = 0.0
    estimated_tokens: bool = False
    agent_duration_seconds: float = 0.0
    verification_duration_seconds: float = 0.0
    prompt_cost_usd: float | None = None
    completion_cost_usd: float | None = None
    model: str = "unspecified"
    finalized: bool = False


def extract_or_estimate_tokens(agent: str, prompt: str, output: str) -> dict[str, int]:
    return telemetry.token_usage(prompt, output)[0]


def calculate_token_cost(agent: str, prompt_tokens: int, completion_tokens: int) -> float:
    return telemetry.token_cost(agent, {"prompt": prompt_tokens, "completion": completion_tokens})


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
                   "claude", "-p", prompt, "--max-turns", "80"],
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


def build_prompt(
    task: dict, config: RuntimeConfig, feedback: str | FailureAnalysis | None = None,
    *, agent: str | None = None,
) -> str:
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
    if isinstance(feedback, FailureAnalysis):
        prompt += "\n" + reflection_engine.synthesize_remediation(task, feedback, agent) + "\n"
    elif feedback:
        prompt += f"\nPrevious attempt failed. Fix any implementation failure below.\n{feedback[-4000:]}\n"
    elif task.get("failure_analysis"):
        analysis = (FailureAnalysis.from_dict(task["failure_analysis"])
                    if isinstance(task["failure_analysis"], dict)
                    else task["failure_analysis"])
        prompt += "\n" + reflection_engine.synthesize_remediation(task, analysis, agent) + "\n"
    if task.get("remediation_task_id"):
        prompt += f"\nImplement localized remediation `{task['remediation_task_id']}` within this task's retry.\n"
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
                    candidate.get("execution_mode") == "parent_retry" or
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
                # Advertise active execution on GitHub so stakeholders can see
                # the issue is claimed. This runs outside the roadmap txn lock.
                number = issue_number_for_task(claimed) if claimed else None
                if number:
                    log(self.config, f"Applying in-progress label on #{number}", claimed["id"])
                    run_cmd(
                        ["gh", "issue", "edit", str(number), "--repo", self.config.repo,
                         "--add-label", "in-progress"],
                        timeout=15,
                        cwd=self.config.project_root,
                    )
                return claimed
        return None

    def finish(self, task_id: str, status: str, **fields: object) -> bool:
        def apply(task: dict, data: dict) -> None:
            task.update(fields)
            task["status"] = status
            task.pop("active_attempt", None)
            if status == "completed":
                task.pop("failure_analysis", None)
                task.pop("failure_summary", None)
            if status in ("completed", "failed", "cancelled"):
                remediation.resolve_tasks(data, task, status)
            data["current_task_id"] = None
        result = self.update(task_id, apply, ("in_progress", "ready_for_verification", "verified"))
        if result:
            try:
                import event_bus
                event_bus.publish("task_transition", {
                    "task_id": task_id,
                    "status": status,
                    "timestamp": timestamp(),
                })
            except Exception:
                pass
        return result

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
            blocked = False

            def dispatch(current: dict, _data: dict) -> None:
                nonlocal blocked
                current["telemetry"] = telemetry.task_telemetry(current, self.config.default_budget_cap_usd)
                blocked = current["telemetry"]["budget"]["exceeded"]
                if not blocked:
                    current["active_attempt"] = {"agent": agent, "phase": "agent", "started_at": timestamp()}
                    task.update(current)

            if not self.update(task_id, dispatch):
                return "cancelled"
            if blocked:
                self.finish(task_id, "failed", last_error="Budget limit reached; dispatch refused")
                return "failed"
            log(self.config, f"Dispatching {task_id} to {agent}", task_id)
            prompt = build_prompt(task, self.config, feedback, agent=agent)
            started = time.monotonic()
            try:
                code, output = execute_agent_task(agent, prompt, self.config)
            except Exception as error:
                code, output = -2, f"Runtime error: {error}"
                failure = "runtime"
            else:
                failure = ("timeout" if code == -1 else "quota" if quota_error(output)
                           else "agent" if code else None)
            agent_duration = time.monotonic() - started
            tokens, estimated = telemetry.token_usage(prompt, output)
            if code == -2:  # Spawn/runtime failure did not reach the provider.
                tokens, estimated = {"prompt": 0, "completion": 0, "total": 0}, False
            cost = telemetry.token_cost(agent, tokens, self.config.token_rates)
            cost_breakdown = telemetry.token_cost_breakdown(agent, tokens, self.config.token_rates)
            verify_code = None
            verify_duration = 0.0
            verification_outcome = None
            analysis = reflection_engine.analyze(code, output) if failure else None
            # Record provider spend before verification so snapshots and budgets
            # reflect it while verification runs, including a later crash/restart.
            attempt = Attempt(agent, timestamp(), code, None, failure, output[-4000:],
                              round(agent_duration, 3), tokens, cost, estimated,
                              round(agent_duration, 3), 0.0,
                              cost_breakdown["prompt_cost_usd"], cost_breakdown["completion_cost_usd"],
                              telemetry.reported_model(output))
            index = 0
            budget_reached = False

            def record(current: dict, _data: dict) -> None:
                nonlocal index, budget_reached
                telemetry.record_attempt(current, asdict(attempt), self.config.default_budget_cap_usd)
                index = len(current["attempts"]) - 1
                budget_reached = current["telemetry"]["budget"]["exceeded"]
                current.pop("active_attempt", None)
                if failure:
                    current["status"] = "in_progress"
                    current["retry_count"] = current.get("retry_count", 0) + 1
                    current["last_error"] = f"{agent}: {failure}\n{output[-4000:]}"
                    current["failure_analysis"] = analysis.to_dict()
                    current["failure_summary"] = analysis.summary
                    current["attempts"][index]["failure_analysis"] = analysis.to_dict()
                    current["attempts"][index]["failure_summary"] = analysis.summary
                elif not budget_reached:
                    current["status"] = "ready_for_verification"
                    current["active_attempt"] = {"agent": agent, "phase": "verification", "started_at": timestamp()}

            if not self.update(task_id, record, ("in_progress", "ready_for_verification")):
                return "cancelled"
            if not failure and not budget_reached:
                log(self.config, f"Verifying {task_id}: {verification}", task_id)
                started = time.monotonic()
                try:
                    result = verify_task.verify_task(task_id, self.config.project_root,
                        timeout=self.config.verification_timeout, runner=run_cmd_split)
                except Exception as error:
                    result = verify_task.VerificationResult("failed", -2, f"Runtime error: {error}")
                verify_duration = round(time.monotonic() - started, 3)
                verification_outcome = result.outcome
                verify_code, output = result.exit_code, result.log_tail
                if result.outcome == "failed":
                    failure = "timeout" if verify_code == -1 else "runtime" if verify_code == -2 else "verification"
                    analysis = (FailureAnalysis.from_dict(result.failure_analysis)
                                if result.failure_analysis else
                                reflection_engine.analyze(verify_code, output, verification))

            def finalize(current: dict, _data: dict) -> None:
                nonlocal budget_reached
                row = current["attempts"][index]
                row.update(verification_exit_code=verify_code, failure=failure,
                    finalized=True,
                    verification_duration_seconds=verify_duration,
                    duration_seconds=round(agent_duration + verify_duration, 3), log_tail=output[-4000:])
                stats = current["telemetry"]
                stats["duration_seconds"] = round(stats["duration_seconds"] + verify_duration, 3)
                stats["verification_duration_seconds"] = round(stats["verification_duration_seconds"] + verify_duration, 3)
                stats["budget"]["cap_usd"] = telemetry.budget_cap(current, self.config.default_budget_cap_usd)
                current["telemetry"] = telemetry.task_telemetry(current, self.config.default_budget_cap_usd)
                budget_reached = current["telemetry"]["budget"]["exceeded"]
                if failure and attempt.failure is None:
                    modes = current["telemetry"]["failure_modes"]
                    modes[failure] = modes.get(failure, 0) + 1
                if budget_reached:
                    modes = current["telemetry"]["failure_modes"]
                    modes["budget_exceeded"] = modes.get("budget_exceeded", 0) + 1
                    if not failure:
                        row["failure"] = "budget_exceeded"
                        current["telemetry"]["failed_attempts"] += 1
                if failure:
                    current["failure_analysis"] = analysis.to_dict()
                    current["failure_summary"] = analysis.summary
                    row["failure_analysis"] = analysis.to_dict()
                    row["failure_summary"] = analysis.summary
                else:
                    current.pop("failure_analysis", None)
                    current.pop("failure_summary", None)
                current.pop("active_attempt", None)
                current["telemetry"] = telemetry.task_telemetry(current, self.config.default_budget_cap_usd)

            if not self.update(task_id, finalize, ("in_progress", "ready_for_verification", "verified")):
                return "cancelled"
            log(self.config, f"{task_id} telemetry: {tokens['total']} tokens (${cost:.6f} estimated cost), "
                f"latency {agent_duration + verify_duration:.2f}s", task_id)
            if budget_reached:
                self.finish(task_id, "failed", last_error="Budget limit reached; further execution refused")
                return "failed"
            if verification_outcome and verification_outcome not in {"verified", "failed"}:
                return verification_outcome
            if failure:
                if failure == "verification" or verify_code is not None:
                    feedback = analysis
                else:
                    feedback = f"{agent}: {failure}\n{output[-4000:]}"
                log(self.config, f"{task_id}: {agent} failed ({failure}); advancing failover chain", task_id)
                continue
            if not self.update(task_id, lambda current, _data: (
                    current.update(completed_agent=agent, last_error=None),
                    current.pop("failure_analysis", None),
                    current.pop("failure_summary", None)), ("verified",)):
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
                        timeout=self.config.verification_timeout, runner=run_cmd_split,
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
    parser.add_argument("--agent-timeout", type=float, default=720)
    parser.add_argument("--budget-cap-usd", type=float, default=None)
    parser.add_argument("--token-rates-json", type=json.loads, default=None,
                        help="Agent prompt/completion USD rates per million tokens")
    args = parser.parse_args()
    runtime = AgentRuntime(RuntimeConfig(
        project_root=args.project_root.resolve(), repo=args.repo,
        remote=args.remote, branch=args.branch, agent_timeout=args.agent_timeout,
        default_budget_cap_usd=args.budget_cap_usd, token_rates=args.token_rates_json,
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
