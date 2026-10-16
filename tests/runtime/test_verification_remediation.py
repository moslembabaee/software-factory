"""Diff correlation and bounded, idempotent patch directives use local Git only."""

import json
from pathlib import Path
import subprocess
import tempfile
import unittest

from failure_analysis import FailureAnalysis, analyze_failure
import verification_remediation as remediation


class RemediationTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory(prefix="sf-patch-")
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name)
        self.git("init", "--quiet", "-b", "main")
        self.git("config", "user.name", "Patch test")
        self.git("config", "user.email", "patch@example.com")
        (self.root / "src").mkdir()
        (self.root / "other").mkdir()
        for name in ("src/worker.ts", "other/worker.ts", "src/staged.ts", "src/deleted.ts", "ROADMAP.json"):
            (self.root / name).write_text("original\n")
        self.git("add", "--all")
        self.git("-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "base")

    def git(self, *args):
        return subprocess.check_output(["git", *args], cwd=self.root, stderr=subprocess.STDOUT, text=True)

    def test_correlates_exact_paths_and_collects_staged_unstaged_and_new_files(self):
        (self.root / "src/worker.ts").write_text("broken implementation\n")
        (self.root / "src/staged.ts").write_text("staged implementation\n")
        self.git("add", "src/staged.ts")
        (self.root / "src/new.ts").write_text("new implementation\n")
        (self.root / "src/deleted.ts").unlink()
        (self.root / "ROADMAP.json").write_text("control change\n")
        analysis = analyze_failure(1, (
            f"TypeError: broken\n    at {self.root}/src/worker.ts:1:2\n"
            "    at other/worker.ts:1:2\n    at src/new.ts:1:2\n"))
        remediation.correlate_changes(analysis, self.root)
        self.assertEqual(set(analysis.changed_files),
                         {"src/worker.ts", "src/staged.ts", "src/new.ts", "src/deleted.ts"})
        self.assertEqual(set(analysis.related_files), {"src/worker.ts", "src/new.ts"})
        self.assertIn("+broken implementation", analysis.diff_excerpt)
        self.assertNotIn("staged implementation", analysis.diff_excerpt)
        self.assertNotIn("control change", analysis.diff_excerpt)
        self.assertEqual(FailureAnalysis.from_dict(json.loads(json.dumps(analysis.to_dict()))), analysis)

    def test_nonrepository_and_unrelated_diagnostics_have_no_false_correlations(self):
        (self.root / "src/worker.ts").write_text("changed\n")
        analysis = analyze_failure(1, "TypeError: bad\n    at other/worker.ts:1:2\n")
        remediation.correlate_changes(analysis, self.root)
        self.assertEqual(analysis.related_files, [])
        self.assertIn("+changed", analysis.diff_excerpt)
        with tempfile.TemporaryDirectory() as directory:
            remediation.correlate_changes(analysis, Path(directory))
        self.assertEqual(analysis.changed_files, [])
        self.assertEqual(analysis.related_files, [])

    def test_bounds_and_redacts_diffs_and_rejects_external_paths(self):
        secret = "ghp_" + "a" * 25
        (self.root / "src/worker.ts").write_text(secret + "\n" + "changed\n" * 1000)
        analysis = analyze_failure(1, "src/worker.ts(1,1): error TS2322: bad")
        remediation.correlate_changes(analysis, self.root)
        self.assertLessEqual(len(analysis.diff_excerpt), 4000)
        self.assertNotIn(secret, analysis.diff_excerpt)
        self.assertIn("[REDACTED]", analysis.diff_excerpt)
        self.assertIsNone(remediation.repository_path("../outside.ts", self.root))
        self.assertIsNone(remediation.repository_path("/etc/passwd", self.root))

    def test_directives_are_deduplicated_bounded_scoped_and_resolved(self):
        parent = {"id": "T-ISSUE-29", "phase": "Community", "verification_cmd": "npm test",
                  "assigned_agent": "codex", "tenant_id": "tenant", "project_id": "project"}
        data = {"tasks": [parent], "current_task_id": parent["id"], "custom": {"keep": 1}}
        first = analyze_failure(1, "src/worker.ts(1,1): error TS2322: bad", "npm test")
        first.related_files = ["src/worker.ts"]
        first.changed_files = ["src/worker.ts", "src/unrelated.ts"]
        task_id = remediation.synthesize_task(data, parent, first)
        self.assertEqual(task_id, remediation.synthesize_task(data, parent, first))
        child = data["tasks"][1]
        self.assertEqual(child["status"], "pending")
        self.assertEqual(child["target_files"], ["src/worker.ts"])
        self.assertIn("npm test", child["description"])
        self.assertEqual((child["tenant_id"], child["project_id"]), ("tenant", "project"))
        self.assertEqual(child["parent_task_id"], parent["id"])
        for i in range(10):
            remediation.synthesize_task(data, parent, analyze_failure(1, f"Error: regression {i}", "npm test"))
        self.assertEqual(len(remediation.remediation_tasks(data, parent["id"])), 3)
        self.assertEqual(data["custom"], {"keep": 1})
        self.assertEqual(data["current_task_id"], parent["id"])
        remediation.resolve_tasks(data, parent, "completed")
        self.assertTrue(all(task["status"] == "completed" for task in data["tasks"][1:]))
        self.assertEqual(len(child["failure_analysis"]["parsed_diagnostics"]), 1)
