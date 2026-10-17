"""Unit and integration tests for self-healing workspace rollback and drift reconciliation."""

from datetime import datetime, timezone
import json
import os
from pathlib import Path
import subprocess
import tempfile
import time
import unittest

from command_runner import run_cmd
import workspace


class WorkspaceRollbackTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="sf-workspace-tests-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.repo = self.root / "repo"
        self.repo.mkdir()

        # Initialize real git repository
        self.git("init", "-q", "-b", "main")
        self.git("config", "user.name", "Factory Test")
        self.git("config", "user.email", "factory@example.com")

        self.initial_file = self.repo / "initial.txt"
        self.initial_file.write_text("stable initial state\n", encoding="utf-8")

        self.roadmap_file = self.repo / "ROADMAP.json"
        self.initial_roadmap = {
            "project": "Software Factory",
            "version": "1.0.0",
            "current_task_id": None,
            "tasks": [
                {
                    "id": "T-001",
                    "title": "Initial Task",
                    "status": "approved",
                    "retry_count": 0,
                }
            ],
        }
        self.roadmap_file.write_text(json.dumps(self.initial_roadmap, indent=2), encoding="utf-8")

        self.git("add", "--all")
        self.git("-c", "commit.gpgsign=false", "commit", "-qm", "Initial stable checkpoint")
        self.initial_sha = self.git("rev-parse", "HEAD")

    def git(self, *args) -> str:
        res = subprocess.run(
            ["git", *args],
            cwd=self.repo,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            check=True,
        )
        return res.stdout.strip()

    def test_parse_status_porcelain_clean(self):
        cleanliness = workspace.parse_status_porcelain("", branch="main", head_sha="123456")
        self.assertTrue(cleanliness.clean)
        self.assertEqual(cleanliness.modified_files, [])
        self.assertEqual(cleanliness.untracked_files, [])
        self.assertEqual(cleanliness.summary, "Workspace is clean")

    def test_parse_status_porcelain_dirty(self):
        porcelain = (
            " M modified.txt\n"
            "?? untracked.py\n"
            " D deleted.txt\n"
            "UU conflict.js\n"
        )
        cleanliness = workspace.parse_status_porcelain(
            porcelain, branch="factory/t-1", head_sha="abc1234", has_index_lock=True
        )
        self.assertFalse(cleanliness.clean)
        self.assertIn("modified.txt", cleanliness.modified_files)
        self.assertIn("untracked.py", cleanliness.untracked_files)
        self.assertIn("deleted.txt", cleanliness.deleted_files)
        self.assertIn("conflict.js", cleanliness.conflict_files)
        self.assertTrue(cleanliness.has_index_lock)
        self.assertIn("index.lock present", cleanliness.summary)

    def test_validate_workspace_cleanliness(self):
        # 1. Initially clean
        status = workspace.validate_workspace_cleanliness(self.repo)
        self.assertTrue(status.clean)
        self.assertEqual(status.head_sha, self.initial_sha)

        # 2. Add uncommitted changes
        self.initial_file.write_text("corrupted dirty edit\n", encoding="utf-8")
        untracked = self.repo / "untracked_test.tmp"
        untracked.write_text("dirty untracked\n", encoding="utf-8")

        dirty_status = workspace.validate_workspace_cleanliness(self.repo)
        self.assertFalse(dirty_status.clean)
        self.assertIn("initial.txt", dirty_status.modified_files)
        self.assertIn("untracked_test.tmp", dirty_status.untracked_files)

    def test_create_checkpoint_and_rollback_workspace(self):
        # Create a checkpoint while clean
        checkpoint = workspace.create_checkpoint(self.repo, task_id="T-001")
        self.assertEqual(checkpoint.commit_sha, self.initial_sha)
        self.assertIsNotNone(checkpoint.roadmap_backup_path)
        self.assertTrue(Path(checkpoint.roadmap_backup_path).exists())

        # Simulate agent failure leaving dirty changes and untracked files
        self.initial_file.write_text("broken agent change\n", encoding="utf-8")
        dirty_new_file = self.repo / "failed_agent_scratch.ts"
        dirty_new_file.write_text("syntax error !!!\n", encoding="utf-8")

        # Corrupt the roadmap during failed task
        corrupted_roadmap = {
            "project": "Software Factory",
            "current_task_id": "T-001",
            "tasks": [{"id": "T-001", "status": "in_progress", "retry_count": 3}],
        }
        self.roadmap_file.write_text(json.dumps(corrupted_roadmap), encoding="utf-8")

        # Create a fake stale index.lock
        lock_file = self.repo / ".git" / "index.lock"
        lock_file.write_text("lock\n", encoding="utf-8")

        # Execute rollback
        rollback_res = workspace.rollback_workspace(
            self.repo,
            checkpoint=checkpoint,
            clean_untracked=True,
            restore_roadmap=True,
            reason="verification_failure_limit",
        )

        self.assertTrue(rollback_res.success)
        self.assertEqual(rollback_res.strategy, "restore_checkpoint")
        self.assertEqual(rollback_res.reason, "verification_failure_limit")
        self.assertTrue(rollback_res.roadmap_restored)

        # Verify dirty files were wiped
        self.assertFalse(dirty_new_file.exists())
        self.assertFalse(lock_file.exists())
        self.assertEqual(self.initial_file.read_text(encoding="utf-8"), "stable initial state\n")

        # Verify roadmap was restored to checkpoint
        restored_roadmap = json.loads(self.roadmap_file.read_text(encoding="utf-8"))
        self.assertEqual(restored_roadmap["current_task_id"], None)
        self.assertEqual(restored_roadmap["tasks"][0]["status"], "approved")

        # Workspace is now completely clean
        post_status = workspace.validate_workspace_cleanliness(self.repo)
        self.assertTrue(post_status.clean)

    def test_detect_roadmap_corruption(self):
        # 1. Valid roadmap
        corrupt, _ = workspace.detect_roadmap_corruption(self.roadmap_file)
        self.assertFalse(corrupt)

        # 2. Corrupt JSON
        self.roadmap_file.write_text("not a valid { json", encoding="utf-8")
        corrupt, detail = workspace.detect_roadmap_corruption(self.roadmap_file)
        self.assertTrue(corrupt)
        self.assertIn("JSON decode error", detail or "")

        # 3. Missing file
        missing = self.repo / "MISSING.json"
        corrupt, detail = workspace.detect_roadmap_corruption(missing)
        self.assertTrue(corrupt)

    def test_reconcile_workspace_drift_restores_corrupted_roadmap(self):
        # Corrupt the roadmap
        self.roadmap_file.write_text("{ broken json content", encoding="utf-8")

        # Reconcile drift
        res = workspace.reconcile_workspace_drift(self.repo)
        self.assertTrue(res.reconciled)
        self.assertTrue(res.restored_roadmap)
        self.assertTrue(any("Restored corrupted ROADMAP.json" in act for act in res.actions_applied))

        # Check restored content
        valid = json.loads(self.roadmap_file.read_text(encoding="utf-8"))
        self.assertEqual(valid["project"], "Software Factory")
        self.assertIsInstance(valid["tasks"], list)

    def test_reconcile_workspace_drift_orphaned_task_and_max_retries(self):
        # Roadmap with orphaned current_task_id and a task exceeding max retries
        drifted = {
            "project": "Software Factory",
            "current_task_id": "T-GHOST",
            "tasks": [
                {
                    "id": "T-ACTIVE",
                    "status": "in_progress",
                    "retry_count": 0,
                },
                {
                    "id": "T-EXCEEDED",
                    "status": "approved",
                    "retry_count": 4,
                },
            ],
        }
        self.roadmap_file.write_text(json.dumps(drifted, indent=2), encoding="utf-8")

        res = workspace.reconcile_workspace_drift(self.repo, max_retries=3)
        self.assertTrue(res.reconciled)
        self.assertEqual(res.previous_current_task_id, "T-GHOST")
        self.assertIsNone(res.new_current_task_id)

        data = json.loads(self.roadmap_file.read_text(encoding="utf-8"))
        self.assertIsNone(data["current_task_id"])

        exceeded = next(t for t in data["tasks"] if t["id"] == "T-EXCEEDED")
        self.assertEqual(exceeded["status"], "failed")
        self.assertIn("exceeded maximum retries", exceeded.get("last_error", ""))


if __name__ == "__main__":
    unittest.main()
