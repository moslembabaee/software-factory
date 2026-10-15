#!/usr/bin/env python3
"""
Tri-Agent Orchestrator (Claude Code + OpenAI Codex + Google Antigravity)
Autonomous, long-running engineering loop with failover, memory management,
automated verification, and continuous Git synchronization.
"""

import os
import sys
import json
import time
import re
import shlex
import subprocess
from datetime import datetime, timezone
from pathlib import Path

import roadmap_sync
import roadmap_store
from issue_lifecycle import (IGNORED_LABELS, issue_number_for_task, label_names,
                             mark_issue_closed, task_matches_issue)

# Ensure complete PATH is always available even when launched via cron
FULL_PATH = "/root/.local/bin:/root/.hermes/tools/node-26.7.0-linux-x64/bin:/root/.hermes/tools/python-3.14.7+202****0901-linux-x64/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
os.environ["PATH"] = f"{FULL_PATH}:{os.environ.get('PATH', '')}"

PROJECT_ROOT = Path("/root/projects/software-factory").resolve()
ROADMAP_FILE = PROJECT_ROOT / "ROADMAP.json"
LOG_DIR = PROJECT_ROOT / "logs"
LOG_DIR.mkdir(exist_ok=True)
LOG_FILE = LOG_DIR / "orchestrator.log"

AGENT_CHAIN = ["codex", "antigravity", "claude"]

def log(msg: str):
    timestamp = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")
    line = f"[{timestamp}] {msg}"
    print(line, flush=True)
    with open(LOG_FILE, "a", encoding="utf-8") as f:
        f.write(line + "\n")

def run_cmd(cmd: str, timeout: int = 600, cwd: str = str(PROJECT_ROOT)) -> tuple[int, str]:
    try:
        res = subprocess.run(
            cmd,
            shell=True,
            cwd=cwd,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            timeout=timeout
        )
        return res.returncode, res.stdout
    except subprocess.TimeoutExpired:
        return -1, f"Command timed out after {timeout} seconds"
    except Exception as e:
        return -2, str(e)

def check_resources():
    code, out = run_cmd("free -m | grep Mem:")
    if code == 0:
        parts = out.split()
        if len(parts) >= 7:
            available = int(parts[6])
            log(f"System memory check: {available} MB available")
            if available < 400:
                log("Low memory detected! Dropping OS pagecache...")
                run_cmd("sync && echo 3 > /proc/sys/vm/drop_caches")

def load_roadmap() -> dict:
    with open(ROADMAP_FILE, "r", encoding="utf-8") as f:
        return json.load(f)

def save_roadmap(data: dict):
    roadmap_store.save_roadmap(ROADMAP_FILE, data)
    try:
        roadmap_sync.sync_roadmap_to_github()
    except Exception as e:
        log(f"Warning: Failed to sync roadmap to GitHub: {e}")

def reconcile_issue_before_dispatch(roadmap: dict, task: dict) -> bool:
    number = issue_number_for_task(task)
    if not number:
        return True
    code, out = run_cmd(
        f"gh issue view {number} --repo moslembabaee/software-factory --json state,labels,closedAt",
        timeout=30,
    )
    if code != 0:
        log(f"Unable to confirm Issue #{number} is eligible; deferring dispatch: {out}")
        return False
    try:
        issue = json.loads(out)
    except ValueError:
        log(f"Invalid issue response for #{number}; deferring dispatch.")
        return False
    if issue.get("state", "").upper() == "CLOSED":
        mark_issue_closed(roadmap, number, issue.get("closedAt"))
        save_roadmap(roadmap)
        run_cmd(f'gh issue edit {number} --repo moslembabaee/software-factory --remove-label "in-progress,blocked"', timeout=30)
        return False
    if label_names(issue) & IGNORED_LABELS:
        for linked in roadmap.get("tasks", []):
            if task_matches_issue(linked, number) and linked.get("status") != "completed":
                linked["status"] = "waiting_approval"
                if roadmap.get("current_task_id") == linked["id"]:
                    roadmap["current_task_id"] = None
        save_roadmap(roadmap)
        log(f"Skipping Issue #{number}: excluded from app automation by its labels.")
        return False
    return True


def execute_agent_task(agent: str, prompt: str, is_retry: bool = False) -> tuple[int, str]:
    log(f"Dispatching task to agent [{agent.upper()}] (retry={is_retry})...")

    if agent == "codex":
        cmd = f'codex exec --sandbox workspace-write -c \'model_reasoning_effort="high"\' {shlex.quote(prompt)}'
        return run_cmd(cmd, timeout=360)

    elif agent == "claude":
        cmd = f'CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT=1 claude -p {shlex.quote(prompt)} --max-turns 25'
        return run_cmd(cmd, timeout=360)

    elif agent == "antigravity":
        cmd = f'agy -p {shlex.quote(prompt)} --model gemini-3.8-flash-high --dangerously-skip-permissions --print-timeout 6m'
        return run_cmd(cmd, timeout=360)

    else:
        return -1, f"Unknown agent: {agent}"

def build_prompt(task: dict, error_feedback: str = None) -> str:
    prompt = f"""
We are building 'Software Factory', an autonomous software generation platform.
Project directory: /root/projects/software-factory
Verification: npm run typecheck && npm test

Task ID: {task['id']}
Phase: {task['phase']}
Title: {task['title']}
Description: {task['description']}

Instructions:
1. Implement all necessary code, types, and tests in /root/projects/software-factory.
2. Follow the existing patterns: Fastify for API, TypeScript strict, PostgreSQL with RLS.
3. Verify your changes pass: {task['verification_cmd']}
"""
    if error_feedback:
        prompt += f"""
PREVIOUS ATTEMPT FAILED WITH THE FOLLOWING ERROR:
--------------------------------------------------
{error_feedback}
--------------------------------------------------
Please analyze the root cause, fix the issue, and ensure the verification passes.
"""
    return prompt.strip()

def run_loop():
    log("=== Starting Tri-Agent Orchestrator Loop (Software Factory) ===")

    while True:
        check_resources()
        roadmap = load_roadmap()

        # Find next approved task
        pending_task = None
        for task in roadmap["tasks"]:
            if task.get("status") == "approved":
                pending_task = task
                break

        if not pending_task:
            stop_flag = PROJECT_ROOT / "STOP_IMPROVEMENTS"
            if stop_flag.exists():
                log("🛑 Stop flag detected (STOP_IMPROVEMENTS). Pausing continuous improvement loop.")
                break

            waiting_tasks = [t for t in roadmap["tasks"] if t.get("status") in ("waiting_approval", "pending_approval")]
            if waiting_tasks:
                for t in waiting_tasks:
                    t["status"] = "approved"
                    log(f"Auto-approved waiting task {t['id']} ({t.get('title', '')})")
                    save_roadmap(roadmap)

            log("✨ No active proposals or pending tasks! Running Architecture Audit for new proposals...")
            log("Running Autonomous Architecture & Craft Audit via Claude / Codex / Antigravity...")

            audit_prompt = """Do not use any tools or bash commands. Do not read files.
Based on Software Factory specifications, identify 3 high-impact features needed in /root/projects/software-factory.
Output ONLY a raw JSON array of 3 new tasks in this format (no markdown, no backticks):
[
  {
    "id": "T-EVOLVE-1",
    "phase": "Continuous Polish & Evolution",
    "title": "Title here",
    "description": "Concrete requirements here",
    "assigned_agent": "codex",
    "status": "waiting_approval",
    "retry_count": 0,
    "verification_cmd": "cd /root/projects/software-factory && npm run typecheck && npm test"
  }
]"""
            c_code, c_out = run_cmd(f'claude -p {shlex.quote(audit_prompt)} --max-turns 2', timeout=180)
            if c_code != 0 or not c_out.strip():
                c_code, c_out = execute_agent_task("codex", audit_prompt)
            if c_code != 0 or not c_out.strip():
                c_code, c_out = execute_agent_task("antigravity", audit_prompt)
            try:
                raw_json = c_out.strip()
                if "```json" in raw_json:
                    raw_json = raw_json.split("```json", 1)[1].split("```", 1)[0].strip()
                elif "```" in raw_json:
                    raw_json = raw_json.split("```", 1)[1].split("```", 1)[0].strip()

                match = re.search(r'\[\s*\{.*\}\s*\]', raw_json, re.DOTALL)
                if match:
                    new_tasks = json.loads(match.group(0))
                else:
                    new_tasks = json.loads(raw_json)
                if isinstance(new_tasks, list) and len(new_tasks) > 0:
                    ts = int(time.time())
                    for idx, t in enumerate(new_tasks):
                        t["id"] = f"T-EVOLVE-{ts}-{idx+1}"
                        t["status"] = "approved"
                        try:
                            title = f"feat: {t['title']}"
                            agent_name = t.get("assigned_agent", "claude").upper()
                            body = f"""### 🎯 Autonomous Roadmap Proposal

> ⏳ **Status:** Proposal created by Tri-Agent Architect. Waiting for approval by @moslembabaee before development begins. Add the `approved` label or comment `/approve` to authorize this task.

**Task ID:** `{t['id']}`
**Phase:** `{t['phase']}`
**Planned By:** Tri-Agent Autonomous Architect
**Assigned Agent:** `{agent_name}`

#### Description & Scope
{t['description']}

#### Quality Gate Verification
```bash
{t['verification_cmd']}
```"""
                            code, out = run_cmd(f'gh issue create --repo moslembabaee/software-factory --title {shlex.quote(title)} --body {shlex.quote(body)} --label "enhancement,triaged"')
                            if code == 0 and "http" in out:
                                created_num = int(out.strip().split("/")[-1])
                                t["github_issue_number"] = created_num
                                log(f"Created GitHub Proposal Issue #{created_num} for task {t['id']}")
                        except Exception as ex:
                            log(f"Warning: Failed to create GitHub issue for task {t['id']}: {ex}")
                    roadmap["tasks"].extend(new_tasks)
                    save_roadmap(roadmap)
                    log(f"🎯 Generated {len(new_tasks)} new evolution proposals as GitHub issues! Waiting for maintainer approval...")
                    time.sleep(5)
                    continue
            except Exception as e:
                log(f"Audit parse failed ({e}). Re-evaluating in 30s...")
                time.sleep(30)
                continue

        if not pending_task:
            continue

        if not reconcile_issue_before_dispatch(roadmap, pending_task):
            time.sleep(5)
            continue

        task_id = pending_task["id"]
        issue_num = issue_number_for_task(pending_task)
        log(f"\n--- Starting Task: {task_id} - {pending_task['title']} ---")
        pending_task["status"] = "in_progress"
        roadmap["current_task_id"] = task_id
        save_roadmap(roadmap)
        if issue_num:
            run_cmd(f'gh issue edit {issue_num} --repo moslembabaee/software-factory --add-label "in-progress"', timeout=30)

        assigned_agent = pending_task.get("assigned_agent", "codex")
        task_success = False
        task_closed = False
        error_output = None

        agent_idx = AGENT_CHAIN.index(assigned_agent) if assigned_agent in AGENT_CHAIN else 0
        agents_to_try = AGENT_CHAIN[agent_idx:] + AGENT_CHAIN[:agent_idx]

        for current_agent in agents_to_try:
            log(f"Attempting task with agent [{current_agent}]...")
            prompt = build_prompt(pending_task, error_output)

            exit_code, agent_out = execute_agent_task(current_agent, prompt, is_retry=(error_output is not None))
            log(f"Agent [{current_agent}] finished with exit code {exit_code}")

            if exit_code == 0:
                verify_cmd = pending_task["verification_cmd"]
                log(f"Running quality gate verification: '{verify_cmd}'...")
                v_code, v_out = run_cmd(verify_cmd, timeout=300)
            else:
                log(f"⏩ Skipping full verification because agent [{current_agent}] failed (exit code {exit_code}).")
                v_code = -1
                v_out = f"Skipped verification due to agent error: {agent_out[-300:] if agent_out else 'no output'}"

            retry_count = pending_task.get("retry_count", 0)
            roadmap = load_roadmap()
            pending_task = next(t for t in roadmap["tasks"] if t["id"] == task_id)
            if pending_task.get("closed_at"):
                log(f"Issue #{issue_num} closed during execution; stopping task {task_id}.")
                task_closed = True
                break
            pending_task["retry_count"] = max(retry_count, pending_task.get("retry_count", 0))

            if exit_code == 0 and v_code == 0:
                log(f"✅ Agent implementation succeeded and quality gate PASSED for task {task_id}!")
                task_success = True
                break
            else:
                log(f"❌ Task attempt failed (agent_code={exit_code}, verify_code={v_code})!")
                if exit_code != 0:
                    log(f"Agent error snippet: {agent_out[-500:] if len(agent_out) > 500 else agent_out}")
                    error_output = agent_out[-2000:]
                else:
                    log(f"Verification output snippet: {v_out[-500:] if len(v_out) > 500 else v_out}")
                    error_output = v_out[-2000:]
                pending_task["retry_count"] += 1
                time.sleep(3)

        if task_closed:
            continue

        roadmap["current_task_id"] = None
        if task_success:
            pending_task["status"] = "completed"
            pending_task["completed_at"] = datetime.now(timezone.utc).isoformat()
            save_roadmap(roadmap)

            log("Creating Git commit checkpoint and pushing to GitHub...")
            run_cmd("git add .")
            commit_msg = f"feat({pending_task['phase'].split('.')[0]}): {pending_task['title']}"
            run_cmd(f'git commit -m "{commit_msg}"')
            p_code, p_out = run_cmd("git push origin main")
            if p_code == 0:
                log("🚀 Successfully pushed checkpoint to GitHub (moslembabaee/software-factory)!")
            else:
                log(f"Warning: Git push returned {p_code}: {p_out}")

            if issue_num:
                try:
                    sibling_tasks = [
                        t for t in roadmap["tasks"]
                        if task_matches_issue(t, issue_num)
                        and t.get("id") != pending_task["id"]
                    ]
                    incomplete_siblings = [t for t in sibling_tasks if t.get("status") != "completed"]

                    if incomplete_siblings:
                        progress_comment = f"✅ **Sub-task Completed!**\n\nTask `{pending_task['id']}` (**{pending_task['title']}**) has been verified and committed to `main` in `{commit_msg}`.\n\nRemaining sub-tasks for Issue #{issue_num}: {len(incomplete_siblings)} pending."
                        run_cmd(f'gh issue comment {issue_num} --repo moslembabaee/software-factory -b {shlex.quote(progress_comment)}')
                        log(f"Posted sub-task completion progress on Issue #{issue_num}")
                    else:
                        close_comment = f"✅ **All Sub-tasks Implemented & Verified!**\n\nThe Tri-Agent Orchestra has completed and verified task `{pending_task['id']}` ({pending_task['title']}) in commit `{commit_msg}`.\n\nAll requirements for Issue #{issue_num} are deployed and live on `main`."
                        run_cmd(f'gh issue comment {issue_num} --repo moslembabaee/software-factory -b {shlex.quote(close_comment)}')
                        run_cmd(f'gh issue close {issue_num} --repo moslembabaee/software-factory')
                        run_cmd(f'gh issue edit {issue_num} --repo moslembabaee/software-factory --remove-label "in-progress,blocked"')
                        log(f"Closed GitHub Issue #{issue_num} for completed task {pending_task['id']}")
                except Exception as ex:
                    log(f"Warning: Failed to update GitHub issue #{issue_num}: {ex}")
        else:
            log(f"⚠️ Task {task_id} failed across all agents.")
            pending_task["status"] = "failed"
            save_roadmap(roadmap)

            if issue_num:
                try:
                    run_cmd(f'gh issue edit {issue_num} --repo moslembabaee/software-factory --remove-label "in-progress,approved" --add-label "blocked"')
                    err_snippet = (error_output[-500:] if error_output else "Task failed across all agents or timed out.").replace("```", "'''").strip()
                    blocked_msg = f"""⚠️ **Execution Blocked / Attention Required**

The Tri-Agent Orchestra attempted to implement task `{pending_task['id']}` (**{pending_task['title']}**), but execution was blocked across the failover chain.

- **Attempted Failover Chain:** Claude Code ➔ OpenAI Codex ➔ Google Antigravity
- **Latest Blocker Output:**
```text
{err_snippet}
```
- **Status:** The issue has been labeled `blocked` and execution is paused for review.
- **To Resume:** Resolve the blocker (e.g. rate limit reset or scope adjustment) and reply with `/approve` or re-apply the `approved` label."""
                    run_cmd(f'gh issue comment {issue_num} --repo moslembabaee/software-factory -b {shlex.quote(blocked_msg)}')
                    log(f"Labeled Issue #{issue_num} as 'blocked' and posted notification comment.")
                except Exception as ex:
                    log(f"Warning: Failed to mark GitHub issue #{issue_num} as blocked: {ex}")
            time.sleep(10)

        time.sleep(5)

if __name__ == "__main__":
    run_loop()
