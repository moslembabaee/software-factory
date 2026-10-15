#!/usr/bin/env python3
"""Trusted repository worker: approved roadmap -> agent -> verification -> Git.

This is the repository automation entry point used by watchdog.sh. It is separate
from the tenant-scoped API/sandbox runtime; never feed it untrusted tenant input.
"""

from __future__ import annotations

import argparse
import fcntl
import json
import os
import re
import shlex
import signal
import subprocess
import tempfile
import time
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable, Literal, Sequence

import roadmap_store
import roadmap_sync
from issue_lifecycle import (
    IGNORED_LABELS, issue_number_for_task, label_names, mark_issue_closed,
)

PROJECT_ROOT = Path(__file__).resolve().parent
REPO = "moslembabaee/software-factory"
AGENT_CHAIN = ("claude", "codex", "antigravity")
OUTPUT_LIMIT = 16_000


@dataclass(frozen=True)
class RuntimeConfig:
    project_root: Path = PROJECT_ROOT
    repo: str = REPO
    remote: str = "origin"
    branch: str = "main"
    agent_timeout: float = 720
    verification_timeout: float = 300
    git_timeout: float = 120
    poll_seconds: float = 5

    @property
    def roadmap_file(self) -> Path:
        return self.project_root / "ROADMAP.json"


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


def log(config: RuntimeConfig, message: str) -> None:
    directory = config.project_root / "logs"
    directory.mkdir(exist_ok=True)
    line = f"[{timestamp()}] {message}"
    print(line, flush=True)
    with (directory / "orchestrator.log").open("a", encoding="utf-8") as output:
        output.write(line + "\n")


def run_cmd(
    command: str | Sequence[str], timeout: float = 720,
    cwd: Path = PROJECT_ROOT,
) -> tuple[int, str]:
    """Shell only for trusted verification commands; argv for agent/Git transport.

    File-backed capture bounds memory. A timeout kills the entire process group,
    including shell children, before another agent can edit the same checkout.
    """
    with tempfile.TemporaryFile() as output:
        try:
            process = subprocess.Popen(
                command, shell=isinstance(command, str), cwd=cwd,
                stdin=subprocess.DEVNULL, stdout=output,
                stderr=subprocess.STDOUT, start_new_session=True,
            )
        except OSError as error:
            return -2, str(error)
        timed_out = False
        try:
            process.wait(timeout=timeout)
        except (subprocess.TimeoutExpired, KeyboardInterrupt) as error:
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            process.wait()
            if isinstance(error, KeyboardInterrupt):
                raise
            timed_out = True
        output.seek(max(0, output.tell() - OUTPUT_LIMIT))
        tail = output.read().decode("utf-8", errors="replace")
        if timed_out:
            return -1, f"Command timed out after {timeout}s\n{tail}"
        return process.returncode, tail


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
    return prompt


class AgentRuntime:
    def __init__(self, config: RuntimeConfig = RuntimeConfig()):
        self.config = config

    def load(self) -> dict:
        return json.loads(self.config.roadmap_file.read_text(encoding="utf-8"))

    def update(self, task_id: str, change: Callable[[dict, dict], None]) -> bool:
        """Mutate only the current live task, never overwrite a concurrent writer."""
        def apply(data: dict) -> bool:
            task = next((t for t in data["tasks"] if t["id"] == task_id), None)
            if (not task or task.get("closed_at") or
                    task.get("status") != "in_progress" or
                    data.get("current_task_id") != task_id):
                return False
            change(task, data)
            return True
        return roadmap_store.update_roadmap(self.config.roadmap_file, apply)

    def eligible(self, task: dict) -> bool:
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

    def claim(self) -> dict | None:
        data = self.load()
        if data.get("current_task_id"):
            return None  # Crash recovery is explicit; do not steal another task.
        for candidate in data["tasks"]:
            if (candidate.get("status") != "approved" or
                    candidate.get("closed_at") or not self.eligible(candidate)):
                continue
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
        return self.update(task_id, apply)

    def publish(self, task: dict) -> tuple[bool, str]:
        commands = [
            ["git", "add", "--all"],
            ["git", "-c", "commit.gpgsign=false", "commit", "-m",
             f"feat(runtime): {task['id']} {task['title']}"],
            ["git", "rev-parse", "HEAD"],
        ]
        sha = ""
        for command in commands:
            code, output = run_cmd(command, self.config.git_timeout, self.config.project_root)
            if code:
                return False, f"{shlex.join(command[:3])} failed ({code}): {output}"
            sha = output.strip()
        # Check closure/cancellation again before the external publication step.
        if not self.update(task["id"], lambda _task, _data: None):
            return False, "Task closed or cancelled before push"
        code, output = run_cmd(
            ["git", "push", self.config.remote, f"{sha}:refs/heads/{self.config.branch}"],
            self.config.git_timeout, self.config.project_root,
        )
        return (False, f"git push failed ({code}): {output}") if code else (True, sha)

    def execute(self, task: dict) -> str:
        task_id = task["id"]
        verification = task.get("verification_cmd")
        if not isinstance(verification, str) or not verification.strip():
            self.finish(task_id, "failed", last_error="Missing verification_cmd; dispatch refused")
            return "failed"
        feedback = None
        for agent in agent_order(task.get("assigned_agent", "claude")):
            if not self.update(task_id, lambda _task, _data: None):
                return "cancelled"
            log(self.config, f"Dispatching {task_id} to {agent}")
            code, output = execute_agent_task(agent, build_prompt(task, self.config, feedback), self.config)
            failure = "quota" if quota_error(output) else ("agent" if code else None)
            verify_code = None
            if not self.update(task_id, lambda _task, _data: None):
                return "cancelled"
            if failure is None:
                log(self.config, f"Verifying {task_id}: {verification}")
                verify_code, output = run_cmd(
                    verification, self.config.verification_timeout, self.config.project_root,
                )
                if verify_code:
                    failure = "verification"
            attempt = Attempt(agent, timestamp(), code, verify_code, failure, output[-4000:])

            def record(current: dict, _data: dict) -> None:
                current.setdefault("attempts", []).append(asdict(attempt))
                if failure:
                    current["retry_count"] = current.get("retry_count", 0) + 1
                    current["last_error"] = f"{agent}: {failure}\n{output[-4000:]}"

            if not self.update(task_id, record):
                return "cancelled"
            if failure:
                feedback = f"{agent}: {failure}\n{output[-4000:]}"
                log(self.config, f"{task_id}: {agent} failed ({failure}); advancing failover chain")
                continue
            success, detail = self.publish(task)
            if not success:
                self.finish(task_id, "failed", last_error=detail, publication_error=detail)
                log(self.config, f"{task_id}: {detail}")
                return "failed"
            if not self.finish(task_id, "completed", completed_at=timestamp(),
                               completed_agent=agent, commit_sha=detail, last_error=None,
                               publication_error=None):
                return "cancelled"
            log(self.config, f"Completed and pushed {task_id} at {detail}")
            return "completed"
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
            task = self.claim()
            if task is None:
                return "idle"
            try:
                return self.execute(task)
            except Exception as error:
                self.finish(task["id"], "failed", last_error=f"Runtime error: {error}")
                log(self.config, f"{task['id']}: runtime error: {error}")
                return "failed"
            finally:
                # Only render local markdown; this never posts GitHub messages.
                data = self.load()
                (self.config.project_root / "ROADMAP.md").write_text(
                    roadmap_sync.generate_roadmap_markdown(data), encoding="utf-8",
                )


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--once", action="store_true", help="Process at most one approved task")
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
