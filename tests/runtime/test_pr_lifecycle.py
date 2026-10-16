"""PR regressions use real local Git and a mocked GitHub boundary; no network."""
import fcntl
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import Mock, patch

import issue_bot
import webhook_server

from github_fixture import GitHubStub
import orchestrator
import pr_lifecycle as lifecycle
import roadmap_store


class PullRequestTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="sf-pr-tests-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.repo = self.root / "repo"
        self.repo.mkdir()
        self.remote = self.root / "remote.git"
        self.git("init", "-q", "-b", "main")
        self.git("config", "user.name", "Factory test")
        self.git("config", "user.email", "factory@example.com")
        subprocess.run(["git", "init", "-q", "--bare", str(self.remote)], check=True)
        self.git("remote", "add", "origin", str(self.remote))
        self.task = {"id": "T-42", "title": "Safe $(touch injected) `title`", "description": "Build a feature",
                     "phase": "Continuous Polish & Evolution", "assigned_agent": "codex",
                     "status": "verified", "verification_cmd": "npm run typecheck && npm test",
                     "verifications": [{"command": "npm run typecheck && npm test", "exit_code": 0}],
                     "requirements": ["Create task branches"], "acceptance_criteria": ["CI passes"],
                     "verification_gates": ["No regression"], "github_issue_number": 42,
                     "custom": {"preserve": True}}
        self.path = self.repo / "ROADMAP.json"
        self.path.write_text(json.dumps({"tasks": [self.task], "current_task_id": "T-42", "metadata": {"keep": True}}))
        (self.repo / "maintainers.json").write_text(json.dumps({"reviewers": ["reviewer", "reviewer", "factory-bot"]}))
        (self.repo / ".gitignore").write_text("logs/\nROADMAP.json.lock\n")
        self.git("add", "--all")
        self.git("-c", "commit.gpgsign=false", "commit", "-qm", "initial")
        self.base_sha = self.git("rev-parse", "HEAD")
        self.git("push", "-q", "origin", "main")
        (self.repo / "feature.txt").write_text("verified feature")
        self.github = GitHubStub()

    def git(self, *args):
        return subprocess.check_output(["git", *args], cwd=self.repo, stderr=subprocess.STDOUT, text=True).strip()

    def latest(self):
        return json.loads(self.path.read_text())["tasks"][0]

    def change(self, **fields):
        def apply(data):
            data["tasks"][0].update(fields)
            return True
        roadmap_store.update_roadmap(self.path, apply)

    def run_lifecycle(self, **kwargs):
        return lifecycle.run_pr_lifecycle_for_verified_task(self.task, self.repo, repo="test/repo",
                                                           runner=kwargs.pop("runner", self.github), timeout=5, **kwargs)

    def calls(self, action):
        return [c for c in self.github.calls if c[:3] == ["gh", "pr", action]]

    def pending(self):
        self.github.ci = [{"status": "IN_PROGRESS", "conclusion": None}]
        ok, result = self.run_lifecycle()
        self.assertTrue(ok, result)
        self.assertFalse(result["merged"])

    def test_success_publishes_task_branch_and_completes_only_after_confirmed_merge(self):
        ok, result = self.run_lifecycle()
        self.assertTrue(ok, result)
        self.assertTrue(result["merged"])
        task = self.latest()
        self.assertEqual(task["status"], "completed")
        self.assertEqual(task["pr_status"], "merged")
        self.assertEqual(task["merge_commit_sha"], "a" * 40)
        self.assertNotEqual(task["commit_sha"], task["merge_commit_sha"])
        self.assertEqual(task["custom"], {"preserve": True})
        self.assertEqual(task["reviewers"], ["reviewer"])
        self.assertEqual(self.git("branch", "--show-current"), "main")
        self.assertEqual(self.git("rev-parse", "main"), self.base_sha)
        remote_sha = subprocess.check_output(["git", "--git-dir", str(self.remote), "rev-parse",
                                              "refs/heads/factory/t-42"], text=True).strip()
        self.assertEqual(remote_sha, task["commit_sha"])
        self.assertEqual(self.git("show", f"{remote_sha}:ROADMAP.json"), self.git("show", f"{self.base_sha}:ROADMAP.json"))
        self.assertFalse((self.repo / "injected").exists())
        command = self.calls("merge")[0]
        self.assertEqual(command[command.index("--match-head-commit") + 1], remote_sha)
        self.assertNotIn("--admin", command)
        body = self.github.bodies[0]
        for requirement in ("T-42", "Create task branches", "CI passes", "No regression", "Closes #42", self.task["verification_cmd"]):
            self.assertIn(requirement, body)
        self.assertIn("--body-file", self.calls("create")[0])
        self.assertNotIn("--body", self.calls("create")[0])

    def test_pending_ci_is_nonblocking_and_retries_do_not_recommit_or_recreate(self):
        self.pending()
        sha = self.latest()["commit_sha"]
        for _ in range(3):
            ok, result = self.run_lifecycle()
            self.assertTrue(ok, result)
        self.assertEqual(len(self.calls("create")), 1)
        self.assertEqual(self.latest()["commit_sha"], sha)
        self.assertEqual(self.latest()["status"], "verified")
        self.assertEqual(self.latest()["ci_status"], "pending")
        self.assertNotIn("completed_at", self.latest())
        self.assertFalse(self.calls("merge"))
        self.assertIsNone(json.loads(self.path.read_text())["current_task_id"])

    def test_check_run_and_legacy_status_states_are_aggregated_conservatively(self):
        self.pending()
        cases = [([], "pending"), ([{"state": "SUCCESS"}], "passed"),
                 ([{"state": "PENDING"}], "pending"), ([{"state": "ERROR"}], "failed"),
                 ([{"status": "COMPLETED", "conclusion": "SKIPPED"}], "pending"),
                 ([{"status": "COMPLETED", "conclusion": "SUCCESS"}, {"state": "EXPECTED"}], "pending")]
        for conclusion in ("FAILURE", "CANCELLED", "TIMED_OUT", "ACTION_REQUIRED", "STARTUP_FAILURE", "STALE"):
            cases.append(([{"status": "COMPLETED", "conclusion": conclusion}], "failed"))
        for checks, expected in cases:
            with self.subTest(checks=checks):
                self.github.ci = checks
                ci = lifecycle.check_pr_ci_status(7, self.repo, runner=self.github)
                self.assertEqual(ci["status"], expected)

    def test_failed_ci_recovers_without_rerunning_agent_or_verification(self):
        self.github.ci = [{"status": "COMPLETED", "conclusion": "FAILURE"}]
        self.assertTrue(self.run_lifecycle()[0])
        self.assertEqual(self.latest()["pr_status"], "ci_failed")
        self.assertFalse(self.calls("merge"))
        self.github.ci = [{"state": "SUCCESS"}]
        self.assertEqual(lifecycle.scan_and_merge_prs(self.repo, runner=self.github, timeout=5), ["T-42"])
        self.assertEqual(lifecycle.scan_and_merge_prs(self.repo, runner=self.github, timeout=5), [])
        self.assertEqual(len(self.calls("merge")), 1)

    def test_consensus_rejection_is_audited_and_clean_retry_can_merge(self):
        self.github.diff_content = "diff --git a/src/app.ts b/src/app.ts\n+eval(input);\n+debugger;\n"
        ok, result = self.run_lifecycle()
        self.assertTrue(ok, result)
        self.assertFalse(result["merged"])
        self.assertEqual(result["review_status"], "changes_requested")
        self.assertEqual(self.latest()["status"], "verified")
        review = self.latest()["consensus_review"]
        self.assertFalse(review["passed"])
        self.assertEqual(review["head_sha"], self.latest()["commit_sha"])
        self.assertEqual(review["base_sha"], self.github.pr["baseRefOid"])
        self.assertEqual([e["role"] for e in review["evaluations"]], ["security", "lint"])
        self.assertIn("review gate rejected", self.latest()["publication_error"])
        self.assertFalse(self.calls("merge"))
        self.github.diff_content = "diff --git a/src/app.ts b/src/app.ts\n+const safe = true;\n"
        self.assertTrue(self.run_lifecycle()[1]["merged"])
        self.assertTrue(self.latest()["consensus_review"]["passed"])

    def test_failed_empty_truncated_and_binary_diffs_never_merge(self):
        self.pending()
        self.github.ci = [{"state": "SUCCESS"}]
        for code, diff in ((1, "offline"), (0, ""), (0, "garbage"),
                           (0, "diff --git a/a b/a\n+" + "a" * lifecycle.OUTPUT_LIMIT),
                           (0, "diff --git a/a b/a\nBinary files a/a and b/a differ\n")):
            with self.subTest(code=code, diff=diff[:60]):
                self.github.diff_error, self.github.diff_content = code, diff
                ok, result = self.run_lifecycle()
                self.assertTrue(ok, result)
                self.assertFalse(result["merged"])
                self.assertFalse(self.latest()["consensus_review"]["passed"])
                self.assertFalse(self.calls("merge"))

    def test_consensus_thresholds_are_enforced_in_actual_merge_path(self):
        ok, result = self.run_lifecycle(review_policy={"min_approvals": 3})
        self.assertTrue(ok, result)
        self.assertFalse(result["merged"])
        self.assertIn("Consensus threshold", result["consensus_review"]["summary"])
        self.assertFalse(self.calls("merge"))
        self.assertTrue(self.run_lifecycle()[1]["merged"])

    def test_live_changes_during_reviews_prevent_merge(self):
        self.pending()
        self.github.ci = [{"state": "SUCCESS"}]
        original = dict(self.github.pr)
        real_dispatch = lifecycle.dispatch_parallel_reviews
        for change in ("headRefOid", "baseRefOid", "baseRefName", "ci", "review", "task"):
            with self.subTest(change=change):
                self.github.pr = dict(original)
                self.github.ci = [{"state": "SUCCESS"}]
                self.github.review_decision = "APPROVED"
                def dispatch(*args, **kwargs):
                    reviews = real_dispatch(*args, **kwargs)
                    if change == "ci":
                        self.github.ci = [{"state": "FAILURE"}]
                    elif change == "review":
                        self.github.review_decision = "CHANGES_REQUESTED"
                    elif change == "task":
                        self.change(requirements=["changed during review"])
                    else:
                        self.github.pr[change] = "different"
                    return reviews
                with patch.object(lifecycle, "dispatch_parallel_reviews", side_effect=dispatch):
                    ok, result = self.run_lifecycle()
                self.assertFalse(result.get("merged", False))
                self.assertFalse(self.calls("merge"))
                self.assertEqual(self.latest()["status"], "verified")

    def test_reviewer_exception_and_deadline_block_actual_merge(self):
        self.pending()
        self.github.ci = [{"state": "SUCCESS"}]
        with patch.object(lifecycle, "evaluate_security_review", side_effect=RuntimeError("private source")):
            ok, result = self.run_lifecycle()
        self.assertTrue(ok, result)
        self.assertFalse(result["merged"])
        self.assertNotIn("private source", json.dumps(self.latest()["consensus_review"]))
        self.assertFalse(self.calls("merge"))
        from threading import Event
        release = Event()
        try:
            with patch.object(lifecycle, "evaluate_security_review", side_effect=lambda *_: release.wait()):
                ok, result = self.run_lifecycle(review_timeout=0.02)
            self.assertTrue(ok, result)
            self.assertFalse(result["merged"])
            self.assertIn("timed out", result["consensus_review"]["evaluations"][0]["summary"])
            self.assertFalse(self.calls("merge"))
        finally:
            release.set()

    def test_drafts_review_requirements_and_merge_conflicts_block_merge(self):
        self.pending()
        self.github.ci = [{"state": "SUCCESS"}]
        for decision, state, draft in (("REVIEW_REQUIRED", "CLEAN", False),
                                       ("CHANGES_REQUESTED", "CLEAN", False),
                                       ("APPROVED", "DIRTY", False), ("APPROVED", "BLOCKED", False),
                                       ("APPROVED", "UNKNOWN", False), ("APPROVED", "CLEAN", True)):
            with self.subTest(decision=decision, state=state, draft=draft):
                self.github.review_decision = decision
                self.github.merge_state = state
                self.github.pr["isDraft"] = draft
                self.assertTrue(self.run_lifecycle()[0])
                self.assertEqual(self.latest()["status"], "verified")
                self.assertFalse(self.calls("merge"))

    def test_changed_pr_head_or_base_never_uses_old_ci_to_merge(self):
        self.pending()
        original = dict(self.github.pr)
        self.github.ci = [{"state": "SUCCESS"}]
        for field in ("headRefOid", "headRefName", "baseRefName"):
            with self.subTest(field=field):
                self.github.pr = {**original, field: "different"}
                self.assertTrue(self.run_lifecycle()[0])
                self.assertEqual(self.latest()["ci_status"], "unknown")
                self.assertIn("differs", self.latest()["publication_error"])
                self.assertFalse(self.calls("merge"))

    def test_queue_acknowledgement_does_not_mark_task_completed(self):
        self.github.queued = True
        self.assertTrue(self.run_lifecycle()[0])
        self.assertEqual(self.latest()["status"], "verified")
        self.assertNotIn("completed_at", self.latest())
        self.github.pr.update(state="MERGED", mergeCommit={"oid": "b" * 40}, mergedAt="2026-10-16T03:00:00Z")
        self.assertTrue(self.run_lifecycle()[1]["merged"])
        self.assertEqual(self.latest()["merge_commit_sha"], "b" * 40)
        self.assertEqual(len(self.calls("merge")), 1)

    def test_merge_error_is_recorded_and_retryable(self):
        self.github.merge_error = "branch protection"
        self.assertTrue(self.run_lifecycle()[0])
        self.assertEqual(self.latest()["status"], "verified")
        self.assertIn("branch protection", self.latest()["publication_error"])
        self.github.merge_error = None
        self.assertTrue(self.run_lifecycle()[1]["merged"])
        self.assertIsNone(self.latest()["publication_error"])

    def test_closed_unmerged_pr_is_terminal_and_does_not_complete_task(self):
        self.pending()
        self.github.pr["state"] = "CLOSED"
        self.assertTrue(self.run_lifecycle()[0])
        self.assertEqual(self.latest()["pr_status"], "closed")
        self.assertEqual(self.latest()["status"], "verified")
        calls = len(self.github.calls)
        self.assertEqual(lifecycle.scan_and_merge_prs(self.repo, runner=self.github), [])
        self.assertEqual(len(self.github.calls), calls)
        self.assertFalse(self.calls("merge"))

    def test_no_current_successful_verification_means_no_git_or_github_actions(self):
        cases = [{"status": "approved"}, {"closed_at": "closed"}, {"verifications": []},
                 {"verifications": [{"exit_code": 0, "skipped": True, "command": self.task["verification_cmd"]}]},
                 {"verifications": [{"exit_code": 1, "command": self.task["verification_cmd"]}]},
                 {"verification_cmd": "new command"}, {"status": "completed"}]
        for fields in cases:
            with self.subTest(fields=fields):
                self.change(**{**self.task, "closed_at": None, **fields})
                commands = []
                def runner(*args):
                    commands.append(args)
                    raise AssertionError("Execution without verification")
                ok, result = self.run_lifecycle(runner=runner)
                self.assertFalse(ok)
                self.assertIn("verification", result["error"])
                self.assertFalse(commands)

    def test_configuration_errors_fail_before_branch_creation(self):
        for content in ("invalid json", "[]", '{"reviewers": "someone"}', '{"reviewers": ["--admin"]}'):
            with self.subTest(content=content):
                (self.repo / "maintainers.json").write_text(content)
                self.assertFalse(self.run_lifecycle()[0])
                self.assertEqual(self.git("branch", "--show-current"), "main")
                self.assertFalse(self.github.calls)

    def test_reviewer_assignment_failure_retries_existing_pr(self):
        self.github.fail_edit = True
        ok, result = self.run_lifecycle()
        self.assertFalse(ok, result)
        self.assertIn("Reviewer assignment", self.latest()["publication_error"])
        self.github.fail_edit = False
        self.assertTrue(self.run_lifecycle()[0])
        self.assertEqual(len(self.calls("create")), 1)
        self.assertEqual(self.latest()["reviewers"], ["reviewer"])
        self.assertNotIn("factory-bot", self.calls("edit")[-1][-1])

    def test_new_verification_or_requirements_cannot_merge_previously_published_code(self):
        self.pending()
        self.github.ci = [{"state": "SUCCESS"}]
        self.change(verifications=[*self.task["verifications"],
                                  {**self.task["verifications"][0], "timestamp": "new run"}])
        ok, result = self.run_lifecycle()
        self.assertFalse(ok)
        self.assertIn("changed since PR publication", result["error"])
        self.assertFalse(self.calls("merge"))

    def test_offline_and_malformed_ci_never_merge(self):
        self.pending()
        self.github.offline = True
        self.assertTrue(self.run_lifecycle()[0])
        self.assertEqual(self.latest()["ci_status"], "unknown")
        self.assertFalse(self.calls("merge"))
        for output in ("not json", "[]", "{}", '{"headRefOid":"abc","statusCheckRollup":[null]}'):
            ci = lifecycle.check_pr_ci_status(7, self.repo, runner=lambda *_: (0, output))
            self.assertEqual(ci["status"], "unknown")

    def test_repository_lock_prevents_concurrent_publication(self):
        directory = self.repo / "logs"
        directory.mkdir()
        with (directory / "pr-lifecycle.lock").open("a") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            ok, result = self.run_lifecycle()
        self.assertFalse(ok)
        self.assertIn("busy", result["error"])
        self.assertFalse(self.github.calls)
        self.assertEqual(self.git("branch", "--show-current"), "main")

    def test_existing_branch_is_not_reset(self):
        self.git("branch", "factory/t-42")
        ok, _ = self.run_lifecycle()
        self.assertFalse(ok)
        self.assertEqual(self.git("rev-parse", "factory/t-42"), self.base_sha)
        self.assertEqual(self.git("branch", "--show-current"), "main")
        self.assertFalse(self.calls("create"))

    def test_unrelated_branch_and_base_branch_reuse_are_refused(self):
        self.git("checkout", "-qb", "other")
        self.assertFalse(self.run_lifecycle()[0])
        self.assertEqual(self.git("branch", "--show-current"), "other")
        self.git("checkout", "main")
        self.change(branch="main")
        self.assertFalse(self.run_lifecycle()[0])
        self.assertFalse(self.calls("create"))

    def test_concurrent_cancellation_before_push_preserves_live_state(self):
        def runner(command, *args):
            result = self.github(command, *args)
            if command[:2] == ["git", "rev-parse"]:
                self.change(status="waiting_approval", closed_at="cancelled")
            return result
        self.assertFalse(self.run_lifecycle(runner=runner)[0])
        self.assertEqual(self.latest()["status"], "waiting_approval")
        self.assertFalse(self.github.calls)
        self.assertFalse(self.calls("create"))

    def test_concurrent_requirements_change_after_ci_read_prevents_merge(self):
        self.pending()
        self.github.ci = [{"state": "SUCCESS"}]
        def runner(command, *args):
            result = self.github(command, *args)
            if command[:3] == ["gh", "pr", "view"]:
                self.change(requirements=["new requirements"])
            return result
        self.assertFalse(self.run_lifecycle(runner=runner)[0])
        self.assertEqual(self.latest()["requirements"], ["new requirements"])
        self.assertFalse(self.calls("merge"))

    def test_unrelated_concurrent_roadmap_edits_survive_publication(self):
        def runner(command, *args):
            if command[:3] == ["gh", "pr", "create"]:
                def update(data):
                    data["metadata"]["concurrent"] = True
                    data["tasks"].append({"id": "new", "status": "approved"})
                    return True
                roadmap_store.update_roadmap(self.path, update)
            return self.github(command, *args)
        self.assertTrue(self.run_lifecycle(runner=runner)[0])
        data = json.loads(self.path.read_text())
        self.assertTrue(data["metadata"]["concurrent"])
        self.assertEqual(data["tasks"][-1]["id"], "new")

    def test_custom_base_and_auto_merge_disabled(self):
        self.git("branch", "-m", "develop")
        ok, result = self.run_lifecycle(base_branch="develop", auto_merge_if_ci_passes=False)
        self.assertTrue(ok, result)
        self.assertFalse(result["merged"])
        self.assertEqual(self.github.pr["baseRefName"], "develop")
        self.assertEqual(self.latest()["base_branch"], "develop")
        self.assertEqual(self.git("branch", "--show-current"), "develop")
        self.assertFalse(self.calls("merge"))

    def test_verification_does_not_close_the_linked_issue_before_merge(self):
        runner = Mock(return_value=(0, ""))
        roadmap = json.loads(self.path.read_text())
        self.assertFalse(issue_bot.sync_task_transitions(roadmap, runner=runner))
        with patch.object(webhook_server, "ROADMAP_FILE", self.path):
            self.assertFalse(webhook_server.handle_task_transition("T-42", "verified", runner=runner))
            self.assertFalse(webhook_server.handle_task_transition("T-42", "completed", runner=runner))
            self.assertEqual(webhook_server.sync_tasks_to_issues(runner=runner), 0)
        runner.assert_not_called()
        self.assertEqual(self.latest()["status"], "verified")
        self.assertNotIn("notified_verified", self.latest())

    def test_staged_scheduler_files_are_refused_without_unstaging_user_changes(self):
        self.change(custom={"staged": True})
        self.git("add", "ROADMAP.json")
        self.assertFalse(self.run_lifecycle()[0])
        self.assertIn("Runtime control files", self.latest()["publication_error"])
        self.assertEqual(self.git("diff", "--cached", "--name-only"), "ROADMAP.json")
        self.assertFalse(self.calls("create"))

    def test_created_pr_is_recovered_after_transport_timeout(self):
        def runner(command, *args):
            result = self.github(command, *args)
            return (-1, "timed out") if command[:3] == ["gh", "pr", "create"] else result
        self.assertTrue(self.run_lifecycle(runner=runner)[1]["merged"])
        self.assertEqual(len(self.calls("create")), 1)

    def test_branch_name_validation_and_maintainer_fallback(self):
        self.assertEqual(lifecycle.get_task_branch_name("T-special!@#_42"), "factory/t-special-42")
        for task_id in ("", "!!!"):
            with self.assertRaises(ValueError):
                lifecycle.get_task_branch_name(task_id)
        self.assertEqual(lifecycle.get_pr_reviewers({"authorized_approvers": ["reviewer"]}), ["reviewer"])
        self.assertEqual(lifecycle.get_pr_reviewers({"reviewers": [], "authorized_approvers": ["reviewer"]}), [])
        self.assertFalse(lifecycle.create_and_checkout_branch("--orphan", self.repo, runner=self.github)[0])


    def test_failed_ci_generates_one_focused_fix_and_caches_diagnostics(self):
        self.github.ci = [{"state": "FAILURE", "context": "CI"}]
        self.github.run_log = "FAIL tests/unit.test.ts > repairs a regression\nTypeError: broken\n    at src/worker.ts:9:2"
        self.assertTrue(self.run_lifecycle()[0])
        parent = self.latest()
        fix = json.loads(self.path.read_text())["tasks"][1]
        self.assertEqual(fix["parent_task_id"], parent["id"])
        self.assertEqual(fix["source_commit_sha"], parent["commit_sha"])
        self.assertEqual(fix["target_branch"], parent["branch"])
        self.assertEqual(fix["verification_cmd"], parent["verification_cmd"])
        self.assertIn("src/worker.ts:9:2", fix["description"])
        self.assertEqual(fix["regression_context"]["error_messages"], ["TypeError: broken"])
        for _ in range(3):
            self.assertTrue(self.run_lifecycle()[0])
        self.assertEqual(len(json.loads(self.path.read_text())["tasks"]), 2)
        log_calls = [c for c in self.github.calls if c[:3] == ["gh", "run", "view"]]
        self.assertEqual(len(log_calls), 1)
        self.assertIn("1234", log_calls[0])
        self.assertIn("test/repo", log_calls[0])
        lists = [c for c in self.github.calls if c[:3] == ["gh", "run", "list"]]
        self.assertIn(parent["commit_sha"], lists[0])

    def test_stale_or_closed_failed_pr_never_creates_repairs(self):
        self.pending()
        original = dict(self.github.pr)
        self.github.ci = [{"state": "FAILURE"}]
        for changes in ({"headRefOid": "b" * 40}, {"headRefName": "other"},
                        {"baseRefName": "other"}, {"state": "CLOSED"}):
            with self.subTest(changes=changes):
                self.github.pr = {**original, **changes}
                self.assertTrue(self.run_lifecycle()[0])
                self.assertEqual(len(json.loads(self.path.read_text())["tasks"]), 1)
        self.assertFalse(any(c[:2] == ["gh", "run"] for c in self.github.calls))

    def test_cancellation_during_log_fetch_cannot_enqueue_repair(self):
        self.github.ci = [{"state": "FAILURE"}]
        def runner(command, *args):
            if command[:3] == ["gh", "run", "view"]:
                self.change(status="cancelled", closed_at="now")
            return self.github(command, *args)
        self.assertFalse(self.run_lifecycle(runner=runner)[0])
        self.assertEqual(self.latest()["status"], "cancelled")
        self.assertEqual(len(json.loads(self.path.read_text())["tasks"]), 1)

    def test_external_checks_without_logs_still_have_bounded_failure_context(self):
        self.github.ci = [{"state": "FAILURE", "context": "external-build"}]
        def runner(command, *args):
            if command[:3] == ["gh", "run", "list"]:
                return 1, "Actions unavailable"
            return self.github(command, *args)
        self.assertTrue(self.run_lifecycle(runner=runner)[0])
        context = json.loads(self.path.read_text())["tasks"][1]["regression_context"]
        self.assertIn("external-build", context["raw_log_tail"])
        self.assertIn("failure", context["summary"])
        self.assertFalse(self.calls("merge"))

    def test_dirty_merge_state_detects_conflicts(self):
        self.pending()
        self.git("checkout", "main")
        (self.repo / "feature.txt").write_text("conflict on main")
        self.git("add", "feature.txt")
        self.git("commit", "-m", "conflict on main")
        self.git("push", "origin", "main")
        self.github.merge_state = "DIRTY"
        ok, result = self.run_lifecycle()
        self.assertTrue(ok, result)
        self.assertFalse(result["merged"])
        task = self.latest()
        self.assertEqual(task["pr_status"], "conflicted")
        self.assertTrue(task["conflict_details"]["has_conflict"])
        self.assertIn("feature.txt", task["conflict_details"]["conflicting_files"])
        self.assertFalse(self.calls("merge"))

    def test_behind_base_clean_rebase_and_reverify_merges_successfully(self):
        self.pending()
        old_commit_sha = self.latest()["commit_sha"]
        self.git("checkout", "main")
        (self.repo / "other.txt").write_text("unrelated commit on main")
        self.git("add", "other.txt")
        self.git("commit", "-m", "advancing main")
        self.git("push", "origin", "main")
        self.github.merge_state = "BEHIND"
        self.github.ci = [{"state": "SUCCESS"}]
        cmd = 'python3 -c "print(\'reverified\')"'
        t = self.latest()
        new_verifs = [{"command": cmd, "exit_code": 0, "timestamp": "2026-10-16T00:00:00Z"}]
        t_updated = {**t, "verification_cmd": cmd, "verifications": new_verifs}
        self.change(verification_cmd=cmd, verifications=new_verifs,
                    published_evidence=lifecycle.publication_evidence(t_updated))
        self.task["verification_cmd"] = cmd
        self.task["verifications"] = new_verifs

        ok, result = self.run_lifecycle()
        self.assertTrue(ok, result)
        self.assertTrue(result["merged"])
        task = self.latest()
        self.assertEqual(task["status"], "completed")
        self.assertEqual(task["pr_status"], "merged")
        self.assertNotEqual(task["commit_sha"], old_commit_sha)
        self.assertTrue(task["rebase_result"]["success"])
        self.assertTrue(task["rebase_result"]["reverified"])
        self.assertTrue(task["rebase_result"]["verification_passed"])
        self.assertEqual(len(self.calls("merge")), 1)

    def test_behind_base_rebase_conflict_aborts_and_marks_conflicted(self):
        self.pending()
        self.git("checkout", "main")
        (self.repo / "feature.txt").write_text("conflicting content on main")
        self.git("add", "feature.txt")
        self.git("commit", "-m", "conflicting commit on main")
        self.git("push", "origin", "main")
        self.github.merge_state = "BEHIND"
        self.github.ci = [{"state": "SUCCESS"}]
        cmd = 'python3 -c "print(\'reverified\')"'
        t = self.latest()
        new_verifs = [{"command": cmd, "exit_code": 0, "timestamp": "2026-10-16T00:00:00Z"}]
        t_updated = {**t, "verification_cmd": cmd, "verifications": new_verifs}
        self.change(verification_cmd=cmd, verifications=new_verifs,
                    published_evidence=lifecycle.publication_evidence(t_updated))
        self.task["verification_cmd"] = cmd
        self.task["verifications"] = new_verifs

        ok, result = self.run_lifecycle()
        self.assertTrue(ok, result)
        self.assertFalse(result["merged"])
        task = self.latest()
        self.assertEqual(task["pr_status"], "conflicted")
        self.assertTrue(task["conflict_details"]["has_conflict"])
        self.assertIn("feature.txt", task["conflict_details"]["conflicting_files"])
        self.assertEqual(self.git("branch", "--show-current"), "main")
        self.assertFalse(self.calls("merge"))

    def test_behind_base_reverification_failure_resets_and_marks_rebase_failed(self):
        self.pending()
        old_commit_sha = self.latest()["commit_sha"]
        self.git("checkout", "main")
        (self.repo / "other.txt").write_text("unrelated commit on main")
        self.git("add", "other.txt")
        self.git("commit", "-m", "advancing main")
        self.git("push", "origin", "main")
        self.github.merge_state = "BEHIND"
        self.github.ci = [{"state": "SUCCESS"}]
        fail_cmd = 'python3 -c "import sys; sys.exit(1)"'
        t = self.latest()
        new_verifs = [{"command": fail_cmd, "exit_code": 0, "timestamp": "2026-10-16T00:00:00Z"}]
        t_updated = {**t, "verification_cmd": fail_cmd, "verifications": new_verifs}
        self.change(verification_cmd=fail_cmd, verifications=new_verifs,
                    published_evidence=lifecycle.publication_evidence(t_updated))
        self.task["verification_cmd"] = fail_cmd
        self.task["verifications"] = new_verifs

        ok, result = self.run_lifecycle()
        self.assertTrue(ok, result)
        self.assertFalse(result["merged"])
        task = self.latest()
        self.assertEqual(task["pr_status"], "rebase_failed")
        self.assertFalse(task["rebase_result"]["success"])
        self.assertTrue(task["rebase_result"]["reverified"])
        self.assertFalse(task["rebase_result"]["verification_passed"])
        self.assertIn("Re-verification", task["publication_error"])
        self.assertEqual(self.git("rev-parse", "factory/t-42"), old_commit_sha)
        self.assertEqual(self.git("branch", "--show-current"), "main")
        self.assertFalse(self.calls("merge"))

    def test_merge_queue_processes_behind_pr_with_clean_rebase(self):
        self.pending()
        old_commit_sha = self.latest()["commit_sha"]
        self.git("checkout", "main")
        (self.repo / "unrelated.txt").write_text("unrelated commit on main")
        self.git("add", "unrelated.txt")
        self.git("commit", "-m", "advance main for merge queue")
        self.git("push", "origin", "main")
        self.github.merge_state = "BEHIND"
        self.github.ci = [{"state": "SUCCESS"}]
        cmd = 'python3 -c "print(\'reverified\')"'
        t = self.latest()
        new_verifs = [{"command": cmd, "exit_code": 0, "timestamp": "2026-10-16T00:00:00Z"}]
        t_updated = {**t, "verification_cmd": cmd, "verifications": new_verifs}
        self.change(verification_cmd=cmd, verifications=new_verifs,
                    published_evidence=lifecycle.publication_evidence(t_updated))
        self.task["verification_cmd"] = cmd
        self.task["verifications"] = new_verifs

        merged = lifecycle.scan_and_merge_prs(self.repo, runner=self.github, timeout=30)
        self.assertEqual(merged, ["T-42"])
        task = self.latest()
        self.assertEqual(task["status"], "completed")
        self.assertEqual(task["pr_status"], "merged")
        self.assertNotEqual(task["commit_sha"], old_commit_sha)
        self.assertTrue(task["rebase_result"]["success"])
        self.assertEqual(len(self.calls("merge")), 1)


if __name__ == "__main__":
    unittest.main()
