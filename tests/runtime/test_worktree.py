"""Unit and integration tests for isolated git worktree execution, conflict detection, and reconciliation."""

import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

import worktree
from worktree import WorktreeManager


class WorktreeManagerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="sf-worktree-tests-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.repo = self.root / "repo"
        self.repo.mkdir()

        # Initialize git repo
        self.git("init", "-q", "-b", "main")
        self.git("config", "user.name", "Factory Test")
        self.git("config", "user.email", "factory@example.com")

        self.initial_file = self.repo / "main.txt"
        self.initial_file.write_text("initial main branch content\n", encoding="utf-8")

        self.roadmap_file = self.repo / "ROADMAP.json"
        self.roadmap_file.write_text(json.dumps({"tasks": [], "current_task_id": None}), encoding="utf-8")

        self.git("add", "--all")
        self.git("-c", "commit.gpgsign=false", "commit", "-qm", "Initial commit on main")
        self.initial_sha = self.git("rev-parse", "HEAD")

        self.manager = WorktreeManager(project_root=self.repo, base_branch="main")

    def git(self, *args, cwd=None) -> str:
        res = subprocess.run(
            ["git", *args],
            cwd=cwd or self.repo,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            check=True,
        )
        return res.stdout.strip()

    def test_create_worktree_and_isolation(self):
        task_id = "T-001"
        info = self.manager.create_worktree(task_id)

        self.assertEqual(info.task_id, task_id)
        self.assertEqual(info.branch, "factory/t-001")
        self.assertTrue(info.path.exists())
        self.assertEqual(info.head_sha, self.initial_sha)

        # Check isolated file modifications
        wt_file = info.path / "worktree_only.txt"
        wt_file.write_text("created inside isolated worktree\n", encoding="utf-8")

        # The main repo should NOT see the file
        self.assertFalse((self.repo / "worktree_only.txt").exists())

        # ROADMAP.json should be synced to worktree
        self.assertTrue((info.path / "ROADMAP.json").exists())

    def test_list_worktrees(self):
        self.manager.create_worktree("T-001")
        self.manager.create_worktree("T-002")

        wts = self.manager.list_worktrees()
        paths = [str(w.path) for w in wts]
        branches = [w.branch for w in wts]

        self.assertIn("main", branches)
        self.assertIn("factory/t-001", branches)
        self.assertIn("factory/t-002", branches)

    def test_cleanup_worktree(self):
        task_id = "T-CLEAN"
        info = self.manager.create_worktree(task_id)
        self.assertTrue(info.path.exists())

        res = self.manager.cleanup_worktree(task_id, delete_branch=True)
        self.assertTrue(res.success)
        self.assertFalse(info.path.exists())

        # Branch should be deleted
        branches = self.git("branch").split()
        self.assertNotIn("factory/t-clean", branches)

    def test_cleanup_stale_worktrees(self):
        info1 = self.manager.create_worktree("T-ACTIVE")
        info2 = self.manager.create_worktree("T-STALE")

        cleaned = self.manager.cleanup_stale_worktrees(active_task_ids=["T-ACTIVE"])
        self.assertIn("t-stale", cleaned)
        self.assertNotIn("t-active", cleaned)
        self.assertTrue(info1.path.exists())
        self.assertFalse(info2.path.exists())

    def test_detect_conflicts_clean(self):
        task_id = "T-CLEAN-MERGE"
        info = self.manager.create_worktree(task_id)

        # Commit non-conflicting change in worktree
        new_file = info.path / "feature.txt"
        new_file.write_text("feature content\n", encoding="utf-8")
        self.git("add", "feature.txt", cwd=info.path)
        self.git("-c", "commit.gpgsign=false", "commit", "-qm", "feat: add feature", cwd=info.path)

        conflict = self.manager.detect_conflicts(task_id)
        self.assertFalse(conflict.has_conflict)
        self.assertEqual(conflict.conflicting_files, [])

    def test_detect_conflicts_with_baseline(self):
        task_id = "T-CONFLICT"
        info = self.manager.create_worktree(task_id)

        # In worktree, modify main.txt
        (info.path / "main.txt").write_text("worktree version of file\n", encoding="utf-8")
        self.git("add", "main.txt", cwd=info.path)
        self.git("-c", "commit.gpgsign=false", "commit", "-qm", "feat: worktree edit", cwd=info.path)

        # In main branch, also modify main.txt differently
        self.initial_file.write_text("divergent main branch edit\n", encoding="utf-8")
        self.git("add", "main.txt")
        self.git("-c", "commit.gpgsign=false", "commit", "-qm", "fix: main branch edit")

        conflict = self.manager.detect_conflicts(task_id)
        self.assertTrue(conflict.has_conflict)
        self.assertIn("main.txt", conflict.conflicting_files)
        self.assertIn("Merge conflict", conflict.error or "")

    def test_detect_concurrent_conflicts_between_tasks(self):
        info1 = self.manager.create_worktree("T-TASK-1")
        info2 = self.manager.create_worktree("T-TASK-2")

        # Task 1 touches shared.txt and file1.txt
        (info1.path / "shared.txt").write_text("task1 edit\n")
        (info1.path / "file1.txt").write_text("task1 only\n")
        self.git("add", "--all", cwd=info1.path)
        self.git("-c", "commit.gpgsign=false", "commit", "-qm", "feat: task1", cwd=info1.path)

        # Task 2 touches shared.txt and file2.txt
        (info2.path / "shared.txt").write_text("task2 edit\n")
        (info2.path / "file2.txt").write_text("task2 only\n")
        self.git("add", "--all", cwd=info2.path)
        self.git("-c", "commit.gpgsign=false", "commit", "-qm", "feat: task2", cwd=info2.path)

        conflicts = self.manager.detect_concurrent_conflicts(["T-TASK-1", "T-TASK-2"])
        self.assertIn("T-TASK-1", conflicts)
        self.assertIn("T-TASK-2", conflicts)
        self.assertTrue(any("shared.txt" in s for s in conflicts["T-TASK-1"]))

    def test_reconcile_and_merge_success(self):
        task_id = "T-RECONCILE"
        info = self.manager.create_worktree(task_id)

        # Add changes in worktree
        (info.path / "feature.txt").write_text("verified feature\n", encoding="utf-8")
        self.git("add", "feature.txt", cwd=info.path)
        self.git("-c", "commit.gpgsign=false", "commit", "-qm", "feat: verified feature", cwd=info.path)

        res = self.manager.reconcile_and_merge(task_id, commit_message="feat(T-RECONCILE): Merge task")
        self.assertTrue(res.success)
        self.assertFalse(res.conflict_detected)
        self.assertTrue(res.cleaned_up)
        self.assertFalse(info.path.exists())

        # Main branch now contains feature.txt
        self.assertTrue((self.repo / "feature.txt").exists())
        self.assertEqual((self.repo / "feature.txt").read_text(), "verified feature\n")

    def test_reconcile_and_merge_aborts_on_conflict(self):
        task_id = "T-RECONCILE-CONFLICT"
        info = self.manager.create_worktree(task_id)

        # Change main.txt in worktree
        (info.path / "main.txt").write_text("worktree incompatible change\n", encoding="utf-8")
        self.git("add", "main.txt", cwd=info.path)
        self.git("-c", "commit.gpgsign=false", "commit", "-qm", "feat: wt change", cwd=info.path)

        # Change main.txt in main
        self.initial_file.write_text("main incompatible change\n", encoding="utf-8")
        self.git("add", "main.txt")
        self.git("-c", "commit.gpgsign=false", "commit", "-qm", "fix: main change")

        res = self.manager.reconcile_and_merge(task_id)
        self.assertFalse(res.success)
        self.assertTrue(res.conflict_detected)
        self.assertIn("main.txt", res.conflicting_files)

        # Main branch is preserved without broken merge markers
        self.assertEqual(self.initial_file.read_text(), "main incompatible change\n")


if __name__ == "__main__":
    unittest.main()
