"""Runtime regressions. Providers are mocked; verification and Git run locally."""

import fcntl
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

import orchestrator as runtime
import roadmap_store
from github_fixture import GitHubStub


class RuntimeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="sf-runtime-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.repo = self.root / "checkout"
        self.repo.mkdir()
        self.remote = self.root / "remote.git"
        self.config = runtime.RuntimeConfig(project_root=self.repo, git_timeout=10)
        self.worker = runtime.AgentRuntime(self.config)
        self.task = {
            "id": "T-007", "title": 'Runtime "quotes" $(touch injected)',
            "phase": "Phase 3: Agent Runtime", "description": "Implement runtime",
            "assigned_agent": "claude", "status": "approved", "retry_count": 0,
            "verification_cmd": f'{sys.executable} -c "print(\'verified\')"',
            "custom_field": {"preserve": True},
        }
        self.write({"tasks": [self.task], "current_task_id": None, "metadata": {"keep": 1}})
        (self.repo / ".gitignore").write_text("logs/\nROADMAP.json.lock\n")
        self.git("init", "--quiet", "-b", "main")
        self.git("config", "user.name", "Runtime test")
        self.git("config", "user.email", "runtime@example.com")
        self.git("add", "--all")
        self.git("-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "initial")
        subprocess.run(["git", "init", "--quiet", "--bare", str(self.remote)], check=True)
        self.git("remote", "add", "origin", str(self.remote))
        (self.repo / "implementation.txt").write_text("verified implementation")
        (self.repo / "maintainers.json").write_text(json.dumps({"reviewers": ["reviewer", "factory-bot"]}))
        self.github = GitHubStub()
        transport = patch.object(runtime, "run_cmd", side_effect=self.github)
        transport.start()
        self.addCleanup(transport.stop)

    def git(self, *args):
        return subprocess.check_output(["git", *args], cwd=self.repo, stderr=subprocess.STDOUT).decode().strip()

    def write(self, data):
        self.config.roadmap_file.write_text(json.dumps(data))

    def data(self):
        return self.worker.load()

    def latest(self):
        return self.data()["tasks"][0]

    def set_task(self, **fields):
        data = self.data()
        data["tasks"][0].update(fields)
        self.write(data)

    def test_success_runs_real_verification_commits_and_pushes_before_completion(self):
        original = runtime.run_cmd

        def observe(command, *args):
            if isinstance(command, list) and command[:2] == ["git", "push"]:
                self.assertEqual(self.latest()["status"], "verified")
                self.assertNotIn("completed_at", self.latest())
            return original(command, *args)

        with patch.object(runtime, "execute_agent_task", return_value=(0, "done")) as agent, \
                patch.object(runtime, "run_cmd", side_effect=observe):
            self.assertEqual(self.worker.run_once(), "completed")
        agent.assert_called_once()
        task = self.latest()
        self.assertEqual(task["status"], "completed")
        self.assertIsNone(self.data()["current_task_id"])
        self.assertEqual(task["completed_agent"], "claude")
        self.assertEqual(task["retry_count"], 0)
        self.assertEqual(task["attempts"][0]["verification_exit_code"], 0)
        self.assertEqual(task["verifications"][0]["exit_code"], 0)
        self.assertEqual(task["custom_field"], {"preserve": True})
        self.assertEqual(self.data()["metadata"], {"keep": 1})
        self.assertEqual(self.git("log", "factory/t-007", "-1", "--format=%s"), f"feat(T-007): {task['title']}")
        remote_sha = subprocess.check_output(
            ["git", "--git-dir", str(self.remote), "rev-parse", "refs/heads/factory/t-007"], text=True,
        ).strip()
        self.assertEqual(task["commit_sha"], remote_sha)
        self.assertFalse((self.repo / "injected").exists())
        self.assertTrue((self.repo / "ROADMAP.md").exists())
        self.assertEqual(self.worker.run_once(), "idle")

    def test_reported_antigravity_quota_fails_over_even_with_zero_exit(self):
        self.set_task(assigned_agent="antigravity")
        error = ('error: Individual quota reached. Resets in 87h47m21s.\n'
                 'AGY_ERROR: {"status":"RESOURCE_EXHAUSTED","error_code":429}')
        with patch.object(runtime, "execute_agent_task", side_effect=[(0, error), (0, "done")]) as agent:
            self.assertEqual(self.worker.run_once(), "completed")
        self.assertEqual([call.args[0] for call in agent.call_args_list], ["antigravity", "claude"])
        self.assertIn(error, agent.call_args_list[1].args[1])
        attempts = self.latest()["attempts"]
        self.assertEqual(attempts[0]["failure"], "quota")
        self.assertIsNone(attempts[0]["verification_exit_code"])
        self.assertEqual(self.latest()["retry_count"], 1)

    def test_timeout_has_distinct_metrics_and_failover_keeps_cumulative_usage(self):
        self.set_task(retry_count=20)
        outputs = [(-1, 'Command timed out after 720 seconds\n{"usage":{"input_tokens":1000,"output_tokens":200}}'),
                   (0, '{"usage":{"input_tokens":2000,"output_tokens":300}}')]
        with patch.object(runtime, "execute_agent_task", side_effect=outputs):
            self.assertEqual(self.worker.run_once(), "completed")
        task = self.latest()
        stats = task["telemetry"]
        self.assertEqual(task["attempts"][0]["failure"], "timeout")
        self.assertEqual(stats["tokens"], {"prompt": 3000, "completion": 500, "total": 3500})
        self.assertAlmostEqual(stats["cost_usd"], .006 + .008)
        self.assertEqual(stats["failure_modes"], {"timeout": 1})
        self.assertEqual(stats["retry_rate"], .5)
        self.assertEqual(stats["failed_attempts"], 1)
        self.assertFalse(stats["estimated_tokens"])
        self.assertGreaterEqual(stats["duration_seconds"], stats["verification_duration_seconds"])
        self.assertNotIn("active_attempt", task)
        self.assertEqual(stats["successful_attempts"], 1)
        self.assertEqual(stats["pending_attempts"], 0)
        self.assertEqual(stats["success_rate"], .5)
        self.assertAlmostEqual(stats["prompt_cost_usd"] + stats["completion_cost_usd"], stats["cost_usd"])

    def test_snapshot_shows_running_agent_then_spend_during_verification(self):
        import build_dashboard
        self.set_task(tenant_id="tenant", project_id="project")
        def agent(*_args):
            snap = build_dashboard.snapshot(self.config.roadmap_file, {"tenantId": "tenant"}, "project")
            self.assertEqual(snap["tasks"][0]["active_attempt"]["agent"], "claude")
            self.assertEqual(snap["tasks"][0]["active_attempt"]["phase"], "agent")
            return 0, '{"model":"reported-model","input_tokens":1000,"output_tokens":200}'
        original = runtime.verify_task.verify_task
        def verify(*args, **kwargs):
            current = self.latest()
            self.assertEqual(current["telemetry"]["tokens"]["total"], 1200)
            self.assertEqual(current["active_attempt"]["phase"], "verification")
            snap = build_dashboard.snapshot(self.config.roadmap_file, {"tenantId": "tenant"}, "project")
            self.assertEqual(snap["metrics"]["successful_attempts"], 0)
            self.assertEqual(snap["metrics"]["pending_attempts"], 1)
            self.assertEqual(snap["metrics"]["models"][0]["model"], "reported-model")
            self.assertEqual(snap["metrics"]["prompt_cost_usd"], .003)
            self.assertEqual(snap["metrics"]["completion_cost_usd"], .003)
            return original(*args, **kwargs)
        with patch.object(runtime, "execute_agent_task", side_effect=agent), \
                patch.object(runtime.verify_task, "verify_task", side_effect=verify):
            self.assertEqual(self.worker.run_once(), "completed")

        self.assertEqual(self.latest()["telemetry"]["successful_attempts"], 1)
        self.assertEqual(self.latest()["telemetry"]["pending_attempts"], 0)

    def test_zero_budget_blocks_provider_dispatch(self):
        self.set_task(budget_cap_usd=0)
        with patch.object(runtime, "execute_agent_task") as agent:
            self.assertEqual(self.worker.run_once(), "failed")
        agent.assert_not_called()
        self.assertTrue(self.latest()["telemetry"]["budget"]["exceeded"])
        self.assertIsNone(self.data()["current_task_id"])

    def test_budget_stops_verification_and_failover_after_spend_reaches_cap(self):
        self.set_task(budget_cap_usd=.006)
        with patch.object(runtime, "execute_agent_task", return_value=(0, '{"input_tokens":1000,"output_tokens":200}')) as agent, \
                patch.object(runtime.verify_task, "verify_task") as verify:
            self.assertEqual(self.worker.run_once(), "failed")
        agent.assert_called_once()
        verify.assert_not_called()
        self.assertEqual(self.latest()["telemetry"]["cost_usd"], .006)
        self.assertEqual(self.latest()["telemetry"]["failure_modes"], {"budget_exceeded": 1})
        # Restart and approval never reset spend.
        self.set_task(status="approved", retry_count=0)
        with patch.object(runtime, "execute_agent_task") as agent:
            self.assertEqual(runtime.AgentRuntime(self.config).run_once(), "failed")
        agent.assert_not_called()

    def test_budget_lowered_during_agent_is_enforced_against_live_state(self):
        self.set_task(budget_cap_usd=1)
        def agent(*_args):
            self.set_task(budget_cap_usd=.001)
            return 1, '{"input_tokens":1000,"output_tokens":200}'
        with patch.object(runtime, "execute_agent_task", side_effect=agent) as execute:
            self.assertEqual(self.worker.run_once(), "failed")
        execute.assert_called_once()
        self.assertEqual(self.latest()["telemetry"]["budget"]["cap_usd"], .001)

    def test_verification_failure_metrics_are_counted_once(self):
        self.set_task(verification_cmd="exit 1")
        with patch.object(runtime, "execute_agent_task", return_value=(0, "done")):
            self.assertEqual(self.worker.run_once(), "failed")
        self.assertEqual(self.latest()["retry_count"], 3)
        self.assertEqual(self.latest()["telemetry"]["failure_modes"], {"verification": 3})
        self.assertEqual(self.latest()["telemetry"]["retry_rate"], .6667)

    def test_provider_errors_skip_verification_and_exhaust_chain_once(self):
        with patch.object(runtime, "execute_agent_task", return_value=(429, "quota")) as agent, \
                patch.object(runtime, "run_cmd") as command:
            self.assertEqual(self.worker.run_once(), "failed")
        self.assertEqual([call.args[0] for call in agent.call_args_list], list(runtime.AGENT_CHAIN))
        command.assert_not_called()
        self.assertEqual(self.latest()["retry_count"], 3)
        self.assertEqual(len(self.latest()["attempts"]), 3)
        self.assertIsNone(self.data()["current_task_id"])
        self.assertEqual(self.worker.run_once(), "idle")
        self.assertNotIn("completed_at", self.latest())

    def test_verification_failure_is_passed_to_next_agent(self):
        marker = self.repo / "ready"
        self.set_task(verification_cmd=f"test -f {marker}")
        calls = []

        def agent(name, prompt, _config):
            calls.append((name, prompt))
            if name == "codex":
                marker.write_text("ready")
            return 0, "done"

        with patch.object(runtime, "execute_agent_task", side_effect=agent):
            self.assertEqual(self.worker.run_once(), "completed")
        self.assertEqual([call[0] for call in calls], ["claude", "codex"])
        self.assertIn("verification", calls[1][1])
        self.assertEqual(self.latest()["attempts"][0]["verification_exit_code"], 1)
        self.assertEqual(self.latest()["retry_count"], 1)
        self.assertEqual([v["exit_code"] for v in self.latest()["verifications"]], [1, 0])
        self.assertEqual(self.latest()["completed_agent"], "codex")

    def test_ready_task_is_verified_and_published_without_dispatch(self):
        self.set_task(status="ready_for_verification")
        with patch.object(runtime, "execute_agent_task") as agent:
            self.assertEqual(self.worker.run_once(), "completed")
        agent.assert_not_called()
        self.assertEqual(self.latest()["status"], "completed")
        self.assertEqual(self.latest()["pr_status"], "merged")
        self.assertIsNone(self.data()["current_task_id"])
        self.assertEqual(self.worker.run_once(), "idle")

    def test_reflection_drives_retry_with_structured_stderr_diagnostics(self):
        command = "echo 'src/service.ts(9,3): error TS2322: Wrong return type' >&2; exit 1"
        self.set_task(verification_cmd=command)
        calls = []

        def agent(name, prompt, _config):
            calls.append((name, prompt))
            if len(calls) == 2:
                analysis = self.latest()["failure_analysis"]
                self.assertEqual(analysis["command"], command)
                self.assertEqual(analysis["parsed_diagnostics"][0]["symbol"], "TS2322")
                self.set_task(verification_cmd="true")
            return 0, "done"

        with patch.object(runtime, "execute_agent_task", side_effect=agent):
            self.assertEqual(self.worker.run_once(), "completed")
        self.assertEqual([name for name, _prompt in calls], ["claude", "codex"])
        self.assertIn("Remediation Prompt for codex", calls[1][1])
        self.assertIn("TS2322", calls[1][1])
        self.assertIn("src/service.ts", calls[1][1])
        self.assertIn("Run the full verification command", calls[1][1])
        self.assertNotIn("failure_analysis", self.latest())
        self.assertIn("TS2322", self.latest()["attempts"][0]["failure_summary"])

    def test_ready_failure_persists_reflection_without_current_task_claim(self):
        self.set_task(status="ready_for_verification", verification_cmd="echo 'Error: regression' >&2; exit 1")
        with patch.object(runtime, "execute_agent_task") as agent:
            self.assertEqual(self.worker.run_once(), "failed")
        agent.assert_not_called()
        self.assertIn("regression", self.latest()["failure_summary"])
        # A later approval resumes from stored diagnostics, addressed to its assignee.
        task = self.latest()
        prompt = runtime.build_prompt(task, self.config, agent="antigravity")
        self.assertIn("Remediation Prompt for antigravity", prompt)
        self.assertIn("regression", prompt)

    def test_retry_repairs_correlated_file_and_resolves_roadmap_directive(self):
        (self.repo / "src").mkdir()
        source = self.repo / "src/service.ts"
        source.write_text("good\n")
        self.git("add", "src/service.ts")
        self.git("-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "baseline service")
        command = ('if [ "$(cat src/service.ts)" != good ]; then '
                   "echo 'src/service.ts(1,1): error TS2322: Wrong return type' >&2; exit 1; fi")
        self.set_task(verification_cmd=command)
        prompts = []

        def agent(_name, prompt, _config):
            prompts.append(prompt)
            if len(prompts) == 1:
                source.write_text("broken\n")
            else:
                child = next(task for task in self.data()["tasks"] if task.get("is_verification_remediation"))
                self.assertEqual(child["status"], "pending")
                self.assertEqual(child["target_files"], ["src/service.ts"])
                self.assertIn(child["id"], prompt)
                self.assertIn("+broken", prompt)
                self.assertEqual(self.latest()["failure_analysis"]["related_files"], ["src/service.ts"])
                source.write_text("good\n")
            return 0, "done"

        with patch.object(runtime, "execute_agent_task", side_effect=agent):
            self.assertEqual(self.worker.run_once(), "completed")
        children = [task for task in self.data()["tasks"] if task.get("is_verification_remediation")]
        self.assertEqual(len(prompts), 2)
        self.assertEqual(len(children), 1)
        self.assertEqual(children[0]["status"], "completed")
        self.assertEqual([record["exit_code"] for record in self.latest()["verifications"]], [1, 0])
        self.assertIn("remediation_task_id", self.latest()["verifications"][0])

    def test_exhausted_retry_chain_resolves_directives_without_independent_dispatch(self):
        self.set_task(verification_cmd="echo 'Error: persistent regression' >&2; exit 1")
        with patch.object(runtime, "execute_agent_task", return_value=(0, "done")) as agent:
            self.assertEqual(self.worker.run_once(), "failed")
            self.assertEqual(agent.call_count, 3)
            self.assertEqual(self.worker.run_once(), "idle")
        children = [task for task in self.data()["tasks"] if task.get("is_verification_remediation")]
        self.assertEqual(len(children), 1)
        self.assertEqual(children[0]["status"], "failed")
        self.assertNotIn("remediation_task_id", self.latest())

    def test_pending_pr_is_polled_without_dispatching_or_verifying_again(self):
        self.github.ci = []
        with patch.object(runtime, "execute_agent_task", return_value=(0, "done")) as agent:
            self.assertEqual(self.worker.run_once(), "ci_pending")
            self.assertEqual(self.worker.run_once(), "ci_pending")
            self.github.ci = [{"state": "SUCCESS"}]
            self.assertEqual(self.worker.run_once(), "completed")
        agent.assert_called_once()
        self.assertEqual(len(self.latest()["verifications"]), 1)
        self.assertEqual(self.latest()["pr_status"], "merged")

    def test_publication_error_retries_without_another_agent_attempt(self):
        self.github.offline = True
        with patch.object(runtime, "execute_agent_task", return_value=(0, "done")) as agent:
            self.assertEqual(self.worker.run_once(), "failed")
            self.assertEqual(self.latest()["status"], "verified")
            self.github.offline = False
            self.assertEqual(self.worker.run_once(), "completed")
        agent.assert_called_once()
        self.assertEqual(len(self.latest()["verifications"]), 1)
        self.assertIsNone(self.latest()["publication_error"])

    def test_next_task_starts_from_updated_base_after_prior_pr_merge(self):
        with patch.object(runtime, "execute_agent_task", return_value=(0, "done")):
            self.assertEqual(self.worker.run_once(), "completed")
        prior_sha = self.latest()["commit_sha"]
        # Simulate GitHub advancing origin/main as part of merging the first PR.
        subprocess.run(["git", "--git-dir", str(self.remote), "update-ref", "refs/heads/main", prior_sha], check=True)
        data = self.data()
        data["tasks"].append({**self.task, "id": "T-008", "status": "approved"})
        self.write(data)
        self.github.pr = None
        self.github.ci = []
        def agent(*_args):
            self.assertEqual(self.git("rev-parse", "HEAD"), prior_sha)
            self.assertEqual((self.repo / "implementation.txt").read_text(), "verified implementation")
            (self.repo / "second.txt").write_text("next task")
            return 0, "done"
        with patch.object(runtime, "execute_agent_task", side_effect=agent):
            self.assertEqual(self.worker.run_once(), "ci_pending")
        self.assertEqual(self.data()["tasks"][1]["branch"], "factory/t-008")
        self.assertEqual(self.latest()["status"], "completed")

    def test_ready_task_failure_returns_to_in_progress(self):
        self.set_task(status="ready_for_verification", verification_cmd="echo broken >&2; exit 7")
        with patch.object(runtime, "execute_agent_task") as agent:
            self.assertEqual(self.worker.run_once(), "failed")
        agent.assert_not_called()
        self.assertEqual(self.latest()["status"], "in_progress")
        self.assertEqual(self.latest()["retry_count"], 1)
        self.assertIn("broken", self.latest()["verification_failures"][0])

    def test_ready_task_without_command_is_skipped_once_until_command_added(self):
        self.set_task(status="ready_for_verification", verification_cmd=None)
        self.assertEqual(self.worker.run_once(), "skipped")
        self.assertEqual(self.latest()["status"], "ready_for_verification")
        self.assertIn("no verification_cmd", self.latest()["verifications"][0]["note"])
        self.assertEqual(self.worker.run_once(), "idle")
        self.assertEqual(len(self.latest()["verifications"]), 1)
        self.set_task(verification_cmd="true")
        self.assertEqual(self.worker.run_once(), "completed")

    def test_agent_may_mark_task_ready_before_returning(self):
        def agent(*_args):
            self.set_task(status="ready_for_verification")
            return 0, "ready"

        with patch.object(runtime, "execute_agent_task", side_effect=agent):
            self.assertEqual(self.worker.run_once(), "completed")
        self.assertEqual(self.latest()["verifications"][0]["exit_code"], 0)

    def test_verification_timeout_fails_over(self):
        self.config = runtime.RuntimeConfig(project_root=self.repo, verification_timeout=0.05)
        self.worker = runtime.AgentRuntime(self.config)
        self.set_task(verification_cmd=f'{sys.executable} -c "import time; time.sleep(10)"')
        with patch.object(runtime, "execute_agent_task", return_value=(0, "done")):
            self.assertEqual(self.worker.run_once(), "failed")
        self.assertEqual(self.latest()["retry_count"], 3)
        self.assertTrue(all(a["verification_exit_code"] == -1 for a in self.latest()["attempts"]))
        analysis = self.latest()["failure_analysis"]
        self.assertEqual(analysis["command"], self.latest()["verification_cmd"])
        self.assertIn("timed out", analysis["summary"])
        self.assertIn("deadlocks", analysis["remediation_hint"])

    def test_missing_or_blank_verification_never_dispatches(self):
        for value in (None, "", "  "):
            with self.subTest(value=value):
                self.set_task(status="approved", verification_cmd=value)
                with patch.object(runtime, "execute_agent_task") as agent:
                    self.assertEqual(self.worker.run_once(), "failed")
                agent.assert_not_called()
                self.assertIn("Missing verification_cmd", self.latest()["last_error"])

    def test_only_approved_tasks_are_dispatched(self):
        for status in ("waiting_approval", "pending_approval", "pending", "failed", "completed", "in_progress"):
            with self.subTest(status=status):
                self.set_task(status=status)
                before = self.data()
                with patch.object(runtime, "execute_agent_task") as agent:
                    self.assertEqual(self.worker.run_once(), "idle")
                agent.assert_not_called()
                self.assertEqual(before, self.data())

    def test_existing_current_task_and_stop_flag_prevent_dispatch(self):
        data = self.data()
        data["current_task_id"] = "another-task"
        self.write(data)
        with patch.object(runtime, "execute_agent_task") as agent:
            self.assertEqual(self.worker.run_once(), "idle")
            (self.repo / "STOP_IMPROVEMENTS").touch()
            self.assertEqual(self.worker.run_once(), "stopped")
        agent.assert_not_called()
        self.assertEqual(self.latest()["status"], "approved")

    def test_repository_lock_prevents_concurrent_workers(self):
        directory = self.repo / "logs"
        directory.mkdir()
        with (directory / "orchestrator.lock").open("a") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            self.assertEqual(self.worker.run_once(), "busy")
        self.assertEqual(self.latest()["status"], "approved")

    def test_concurrent_issue_close_is_never_overwritten_or_pushed(self):
        def agent(_name, _prompt, _config):
            def close(data):
                data["tasks"][0].update(status="completed", closed_at="external-close")
                data["current_task_id"] = None
                return True
            roadmap_store.update_roadmap(self.config.roadmap_file, close)
            return 0, "done"

        with patch.object(runtime, "execute_agent_task", side_effect=agent), \
                patch.object(runtime, "run_cmd") as command:
            self.assertEqual(self.worker.run_once(), "cancelled")
        command.assert_not_called()
        self.assertEqual(self.latest()["closed_at"], "external-close")
        self.assertNotIn("commit_sha", self.latest())

    def test_external_cancellation_during_verification_prevents_publish(self):
        def verify(*_args):
            data = self.data()
            data["tasks"][0]["status"] = "waiting_approval"
            data["current_task_id"] = None
            self.write(data)
            return 0, "verified"

        with patch.object(runtime, "execute_agent_task", return_value=(0, "done")), \
                patch.object(runtime, "run_cmd_split", side_effect=verify) as command:
            self.assertEqual(self.worker.run_once(), "cancelled")
        self.assertEqual(command.call_count, 1)
        self.assertEqual(self.latest()["status"], "waiting_approval")

    def test_concurrent_roadmap_additions_survive_attempt_updates(self):
        def agent(_name, _prompt, _config):
            data = self.data()
            data["metadata"]["concurrent"] = True
            data["tasks"].append({"id": "new-task", "status": "waiting_approval"})
            self.write(data)
            return 1, "unavailable"

        with patch.object(runtime, "execute_agent_task", side_effect=agent):
            self.assertEqual(self.worker.run_once(), "failed")
        self.assertTrue(self.data()["metadata"]["concurrent"])
        self.assertEqual(self.data()["tasks"][1]["id"], "new-task")
        self.assertEqual(len(self.latest()["attempts"]), 3)

    def test_commit_failure_never_pushes_or_completes(self):
        hook = self.repo / ".git/hooks/pre-commit"
        hook.write_text("#!/bin/sh\nexit 1\n")
        hook.chmod(0o755)
        original = runtime.run_cmd
        with patch.object(runtime, "execute_agent_task", return_value=(0, "done")), \
                patch.object(runtime, "run_cmd", wraps=original) as command:
            self.assertEqual(self.worker.run_once(), "failed")
        self.assertFalse(any(c.args[0][:2] == ["git", "push"] for c in command.call_args_list))
        self.assertIn("commit", self.latest()["publication_error"])
        self.assertNotIn("completed_at", self.latest())
        self.assertEqual(self.git("rev-list", "--count", "HEAD"), "1")

    def test_push_rejection_preserves_commit_and_fails_task(self):
        hook = self.remote / "hooks/pre-receive"
        hook.write_text("#!/bin/sh\nexit 1\n")
        hook.chmod(0o755)
        with patch.object(runtime, "execute_agent_task", return_value=(0, "done")) as agent:
            self.assertEqual(self.worker.run_once(), "failed")
        agent.assert_called_once()
        self.assertIn("git push failed", self.latest()["publication_error"])
        self.assertEqual(self.latest()["status"], "verified")
        self.assertNotIn("completed_at", self.latest())
        self.assertIsNone(self.data()["current_task_id"])
        self.assertEqual(self.git("rev-list", "--count", "HEAD"), "2")

    def test_staging_failure_prevents_commit(self):
        original = runtime.run_cmd

        def command(argv, *args):
            if isinstance(argv, list) and argv[:2] == ["git", "add"]:
                return 1, "index.lock exists"
            return original(argv, *args)

        with patch.object(runtime, "execute_agent_task", return_value=(0, "done")), \
                patch.object(runtime, "run_cmd", side_effect=command):
            self.assertEqual(self.worker.run_once(), "failed")
        self.assertIn("index.lock", self.latest()["publication_error"])
        self.assertEqual(self.git("rev-list", "--count", "HEAD"), "1")

    def test_closed_and_excluded_issues_cannot_dispatch(self):
        self.set_task(github_issue_number=21)
        responses = [
            {"state": "CLOSED", "labels": [], "closedAt": "closed"},
            {"state": "OPEN", "labels": [{"name": "manual"}], "closedAt": None},
        ]
        for issue in responses:
            with self.subTest(issue=issue):
                self.set_task(status="approved", closed_at=None)
                with patch.object(runtime, "run_cmd", return_value=(0, json.dumps(issue))), \
                        patch.object(runtime, "execute_agent_task") as agent:
                    self.assertEqual(self.worker.run_once(), "idle")
                agent.assert_not_called()
        self.assertEqual(self.latest()["status"], "approved")

    def test_issue_api_failure_defers_without_claiming(self):
        self.set_task(github_issue_number=21)
        for code, output in [(1, "offline"), (0, "invalid JSON"), (0, "{}")]:
            with patch.object(runtime, "run_cmd", return_value=(code, output)), \
                    patch.object(runtime, "execute_agent_task") as agent:
                self.assertEqual(self.worker.run_once(), "idle")
            agent.assert_not_called()
        self.assertEqual(self.latest()["status"], "approved")

    def test_once_cli_exits_on_idle_without_dispatching(self):
        self.set_task(status="waiting_approval")
        process = subprocess.run(
            [sys.executable, str(runtime.PROJECT_ROOT / "orchestrator.py"),
             "--once", "--project-root", str(self.repo)],
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, timeout=5,
        )
        self.assertEqual(process.returncode, 0, process.stdout)
        self.assertEqual(self.latest()["status"], "waiting_approval")

    def test_sigterm_stops_active_agent_process_group(self):
        binary = self.root / "bin"
        binary.mkdir()
        marker = self.root / "agent-pid"
        agent = binary / "claude"
        agent.write_text(
            f"#!{sys.executable}\nimport os,time\n"
            f"open({str(marker)!r}, 'w').write(str(os.getpid()))\n"
            "time.sleep(60)\n"
        )
        agent.chmod(0o755)
        process = subprocess.Popen(
            [sys.executable, str(runtime.PROJECT_ROOT / "orchestrator.py"),
             "--once", "--project-root", str(self.repo)],
            env={**os.environ, "PATH": f"{binary}:{os.environ['PATH']}"},
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        )
        try:
            deadline = time.monotonic() + 5
            while not marker.exists() and process.poll() is None and time.monotonic() < deadline:
                time.sleep(0.01)
            self.assertTrue(marker.exists(), "CLI never dispatched the test agent")
            process.terminate()
            self.assertEqual(process.wait(timeout=5), 0)
            pid = int(marker.read_text())
            stat = Path(f"/proc/{pid}/stat")
            self.assertTrue(not stat.exists() or stat.read_text().split()[2] == "Z")
            self.assertEqual(self.latest()["status"], "in_progress")
            self.assertNotIn("commit_sha", self.latest())
        finally:
            if process.poll() is None:
                process.kill()
                process.wait()
            if marker.exists():
                try:
                    os.killpg(int(marker.read_text()), signal.SIGKILL)
                except ProcessLookupError:
                    pass

    def test_runtime_exception_fails_without_stuck_current_task(self):
        with patch.object(runtime, "execute_agent_task", side_effect=OSError("provider missing")):
            self.assertEqual(self.worker.run_once(), "failed")
        self.assertIn("provider missing", self.latest()["last_error"])
        self.assertIsNone(self.data()["current_task_id"])


    def fail_ci(self):
        self.github.ci = [{"status": "COMPLETED", "conclusion": "FAILURE", "name": "unit tests"}]
        self.github.run_log = (
            "tests\tRun tests\t2026-10-16T02:00:00.000Z  FAIL tests/example.test.ts > regression\n"
            "tests\tRun tests\t2026-10-16T02:00:00.000Z AssertionError: expected repaired\n"
            "tests\tRun tests\t2026-10-16T02:00:00.000Z     at src/example.ts:10:5\n")
        with patch.object(runtime, "execute_agent_task", return_value=(0, "done")):
            self.assertEqual(self.worker.run_once(), "ci_pending")
        return self.data()["tasks"][1]

    def test_ci_repair_dispatches_on_failed_branch_and_updates_existing_pr(self):
        self.set_task(tenant_id="tenant-a", project_id="project-a")
        fix = self.fail_ci()
        source = self.latest()["commit_sha"]
        self.assertEqual(fix["source_commit_sha"], source)
        self.assertEqual((fix["tenant_id"], fix["project_id"]), ("tenant-a", "project-a"))
        self.assertEqual(fix["regression_context"]["error_messages"], ["AssertionError: expected repaired"])

        def repair(_agent, prompt, _config):
            self.assertEqual(self.git("branch", "--show-current"), fix["target_branch"])
            self.assertEqual(self.git("rev-parse", "HEAD"), source)
            self.assertEqual((self.repo / "implementation.txt").read_text(), "verified implementation")
            self.assertIn("src/example.ts:10:5", prompt)
            self.assertIn("add or update a regression test", prompt)
            self.assertIn(source, prompt)
            (self.repo / "implementation.txt").write_text("repaired implementation")
            self.github.ci = [{"status": "IN_PROGRESS"}]
            return 0, "repaired"

        with patch.object(runtime, "execute_agent_task", side_effect=repair) as agent:
            self.assertEqual(self.worker.run_once(), "ci_pending")
        agent.assert_called_once()
        fixed = self.data()["tasks"][1]
        self.assertEqual(fixed["status"], "verified")
        self.assertEqual(self.latest()["status"], "verified")
        self.assertNotEqual(fixed["commit_sha"], source)
        self.assertEqual(fixed["pr_number"], self.latest()["pr_number"])
        self.assertEqual(len([c for c in self.github.calls if c[:3] == ["gh", "pr", "create"]]), 1)
        self.assertEqual(self.git("branch", "--show-current"), "main")
        with patch.object(runtime, "execute_agent_task") as agent:
            self.assertEqual(self.worker.run_once(), "ci_pending")
            self.github.ci = [{"state": "SUCCESS"}]
            self.assertEqual(self.worker.run_once(), "completed")
        agent.assert_not_called()
        self.assertTrue(all(t["status"] == "completed" for t in self.data()["tasks"]))
        self.assertEqual(len(fixed["verifications"]), 1)
        self.assertEqual(self.latest()["merge_commit_sha"], self.data()["tasks"][1]["merge_commit_sha"])
        self.assertIsNone(self.data()["current_task_id"])
        self.assertEqual(self.worker.run_once(), "idle")

    def test_repair_refuses_changed_pr_before_agent_dispatch(self):
        self.fail_ci()
        self.github.pr["headRefOid"] = "b" * 40
        with patch.object(runtime, "execute_agent_task") as agent:
            self.assertEqual(self.worker.run_once(), "failed")
        agent.assert_not_called()
        self.assertEqual(self.data()["tasks"][1]["status"], "failed")
        self.assertEqual(self.latest()["status"], "verified")
        self.assertIsNone(self.data()["current_task_id"])

    def test_failed_repair_is_not_regenerated_on_each_tick(self):
        self.fail_ci()
        with patch.object(runtime, "execute_agent_task", return_value=(1, "cannot repair")) as agent:
            self.assertEqual(self.worker.run_once(), "failed")
            self.assertEqual(self.worker.run_once(), "idle")
        self.assertEqual(agent.call_count, len(runtime.AGENT_CHAIN))
        self.assertEqual(len(self.data()["tasks"]), 2)

    def test_repair_without_code_changes_does_not_regenerate_same_failure(self):
        self.fail_ci()
        with patch.object(runtime, "execute_agent_task", return_value=(0, "no change")) as agent:
            self.assertEqual(self.worker.run_once(), "ci_pending")
            self.assertEqual(self.worker.run_once(), "ci_pending")
        agent.assert_called_once()
        self.assertEqual(len(self.data()["tasks"]), 2)
        self.assertEqual(self.data()["tasks"][1]["self_healing_status"], "exhausted")

    def test_repeated_failed_heads_have_bounded_healing_depth(self):
        self.fail_ci()
        # Each repair passes local verification but still fails in CI.
        def repair(*_args):
            (self.repo / "implementation.txt").write_text(str(len(self.data()["tasks"])))
            return 0, "locally verified"
        with patch.object(runtime, "execute_agent_task", side_effect=repair) as agent:
            for _ in range(runtime.pr_lifecycle.MAX_HEALING_ATTEMPTS):
                self.assertEqual(self.worker.run_once(), "ci_pending")
            self.assertEqual(self.worker.run_once(), "ci_pending")
        self.assertEqual(agent.call_count, runtime.pr_lifecycle.MAX_HEALING_ATTEMPTS)
        self.assertEqual(len(self.data()["tasks"]), 1 + runtime.pr_lifecycle.MAX_HEALING_ATTEMPTS)
        self.assertFalse(any(c[:3] == ["gh", "pr", "merge"] for c in self.github.calls))


    def test_approved_ci_repair_precedes_unrelated_pending_pr(self):
        self.fail_ci()
        data = self.data()
        data["tasks"].append({**self.latest(), "id": "T-unrelated", "bugfix_task_id": None})
        self.write(data)
        self.github.ci = [{"status": "IN_PROGRESS"}]
        with patch.object(runtime, "execute_agent_task", return_value=(0, "repaired")) as agent:
            self.assertEqual(self.worker.run_once(), "ci_pending")
        agent.assert_called_once()
        self.assertIn("Task ID: T-007-FIX\n", agent.call_args.args[1])
        self.assertEqual(self.data()["tasks"][2]["status"], "verified")

    def test_parent_requirements_change_during_repair_prevents_push(self):
        self.fail_ci()
        before = self.github.pr["headRefOid"]
        def repair(*_args):
            self.set_task(requirements=["Changed requirement"])
            return 0, "repaired"
        with patch.object(runtime, "execute_agent_task", side_effect=repair):
            self.assertEqual(self.worker.run_once(), "failed")
        self.assertEqual(self.github.pr["headRefOid"], before)
        self.assertEqual(self.latest()["requirements"], ["Changed requirement"])
        self.assertIsNone(self.data()["current_task_id"])
        self.assertFalse(any(c[:3] == ["gh", "pr", "merge"] for c in self.github.calls))

    def test_repair_push_timeout_after_remote_acceptance_is_recoverable(self):
        self.fail_ci()
        original = runtime.run_cmd
        accepted = False
        def runner(command, *args):
            nonlocal accepted
            result = original(command, *args)
            if isinstance(command, list) and command[:2] == ["git", "push"] and not accepted:
                accepted = True
                return -1, "transport timed out after push"
            return result
        def repair(*_args):
            (self.repo / "implementation.txt").write_text("repaired implementation")
            self.github.ci = [{"status": "IN_PROGRESS"}]
            return 0, "repaired"
        with patch.object(runtime, "execute_agent_task", side_effect=repair), \
                patch.object(runtime, "run_cmd", side_effect=runner):
            self.assertEqual(self.worker.run_once(), "failed")
        fixed = self.data()["tasks"][1]
        self.assertEqual(fixed["status"], "verified")
        self.assertEqual(fixed["repair_commit_sha"], self.github.pr["headRefOid"])
        with patch.object(runtime, "execute_agent_task") as agent:
            self.assertEqual(self.worker.run_once(), "ci_pending")
        agent.assert_not_called()
        self.assertEqual(len(self.data()["tasks"][1]["verifications"]), 1)
        self.assertEqual(len([c for c in self.github.calls if c[:3] == ["gh", "pr", "create"]]), 1)


class TransportTests(unittest.TestCase):
    def test_chain_rotation_and_unknown_assignment(self):
        self.assertEqual(runtime.agent_order("claude"), ("claude", "codex", "antigravity"))
        self.assertEqual(runtime.agent_order("codex"), ("codex", "antigravity", "claude"))
        self.assertEqual(runtime.agent_order("antigravity"), ("antigravity", "claude", "codex"))
        self.assertEqual(runtime.agent_order("unknown"), runtime.AGENT_CHAIN)

    def test_agent_commands_use_argv_and_configured_directory(self):
        config = runtime.RuntimeConfig(project_root=Path("/tmp/example"), agent_timeout=12)
        prompt = 'literal "$(touch bad)"; keep as one argument'
        for agent, executable in [("claude", "env"), ("codex", "codex"), ("antigravity", "agy")]:
            with self.subTest(agent=agent), patch.object(runtime, "run_cmd", return_value=(0, "done")) as command:
                self.assertEqual(runtime.execute_agent_task(agent, prompt, config), (0, "done"))
                argv, timeout, cwd = command.call_args.args
                self.assertEqual(argv[0], executable)
                self.assertIn(prompt, argv)
                self.assertEqual((timeout, cwd), (12, config.project_root))

    def test_missing_cli_is_an_agent_failure(self):
        code, output = runtime.run_cmd(["/nonexistent/software-factory-agent"])
        self.assertEqual(code, -2)
        self.assertIn("No such file", output)

    def test_output_capture_returns_bounded_tail(self):
        code, output = runtime.run_cmd([
            sys.executable, "-c", "import sys; sys.stdout.write('x' * 100000 + 'END')",
        ])
        self.assertEqual(code, 0)
        self.assertLessEqual(len(output.encode()), runtime.OUTPUT_LIMIT)
        self.assertTrue(output.endswith("END"))

    def test_timeout_kills_descendants_before_returning(self):
        with tempfile.TemporaryDirectory() as directory:
            marker = Path(directory) / "child-pid"
            program = (
                "import subprocess,sys,time; "
                "p=subprocess.Popen([sys.executable,'-c','import time; time.sleep(60)']); "
                f"open({str(marker)!r},'w').write(str(p.pid)); time.sleep(60)"
            )
            code, output = runtime.run_cmd([sys.executable, "-c", program], timeout=0.3)
            self.assertEqual(code, -1)
            self.assertIn("timed out", output)
            pid = int(marker.read_text())
            # A killed orphan may remain a zombie briefly; it must not be running.
            for _ in range(50):
                stat = Path(f"/proc/{pid}/stat")
                try:
                    if not stat.exists() or stat.read_text().split()[2] == "Z":
                        break
                except (FileNotFoundError, ProcessLookupError):
                    break
                time.sleep(0.01)
            else:
                os.kill(pid, signal.SIGKILL)
                self.fail("Timed-out command left its child process running")

    def test_quota_detection_does_not_match_ordinary_provider_explanation(self):
        self.assertFalse(runtime.quota_error("Implemented handling for RESOURCE_EXHAUSTED and 429."))
        self.assertTrue(runtime.quota_error('AGY_ERROR: {"status":"RESOURCE_EXHAUSTED"}'))
        self.assertTrue(runtime.quota_error("error: Individual quota reached."))


if __name__ == "__main__":
    unittest.main()
