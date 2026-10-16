"""In-memory GitHub transport; Git commands still use a temporary real repository."""
import copy
import json
from pathlib import Path
import subprocess

from command_runner import run_cmd


class GitHubStub:
    def __init__(self):
        self.pr = None
        self.calls = []
        self.bodies = []
        self.ci = [{"__typename": "CheckRun", "status": "COMPLETED", "conclusion": "SUCCESS"}]
        self.merge_state = "CLEAN"
        self.review_decision = "APPROVED"
        self.merge_error = None
        self.queued = False
        self.fail_edit = False
        self.offline = False
        self.run_log = ""
        self.diff_error = 0

    def __call__(self, argv, timeout, root):
        if not isinstance(argv, list) or argv[0] != "gh":
            result = run_cmd(argv, timeout, root)
            if isinstance(argv, list) and argv[:2] == ["git", "push"] and result[0] == 0 and self.pr:
                self.pr["headRefOid"] = subprocess.check_output(
                    ["git", "rev-parse", self.pr["headRefName"]], cwd=root, text=True).strip()
                if self.merge_state == "BEHIND":
                    self.merge_state = "CLEAN"
            return result
        self.calls.append(argv)
        if self.offline:
            return 1, "offline"
        if argv[:3] == ["gh", "api", "user"]:
            return 0, json.dumps({"login": "factory-bot"})
        if argv[:3] == ["gh", "pr", "list"]:
            return 0, json.dumps([self.pr] if self.pr else [])
        if argv[:3] == ["gh", "pr", "create"]:
            branch = argv[argv.index("--head") + 1]
            base = argv[argv.index("--base") + 1]
            sha = subprocess.check_output(["git", "rev-parse", branch], cwd=root, text=True).strip()
            self.bodies.append(Path(argv[argv.index("--body-file") + 1]).read_text())
            self.pr = {"number": 7, "url": "https://github.com/test/repo/pull/7", "state": "OPEN",
                       "headRefOid": sha, "headRefName": branch, "baseRefName": base,
                       "baseRefOid": subprocess.check_output(["git", "rev-parse", base], cwd=root, text=True).strip(),
                       "isDraft": False, "mergeCommit": None, "mergedAt": None}
            return 0, self.pr["url"]
        if argv[:3] == ["gh", "pr", "edit"]:
            return (1, "reviewer unavailable") if self.fail_edit else (0, "")
        if argv[:3] == ["gh", "pr", "view"]:
            if not self.pr:
                return 1, "missing PR"
            return 0, json.dumps({**self.pr, "statusCheckRollup": copy.deepcopy(self.ci),
                                  "mergeStateStatus": self.merge_state, "reviewDecision": self.review_decision})
        if argv[:3] == ["gh", "pr", "merge"]:
            if self.merge_error:
                return 1, self.merge_error
            if not self.queued:
                self.pr.update(state="MERGED", mergeCommit={"oid": "a" * 40},
                               mergedAt="2026-10-16T02:00:00Z")
            return 0, ""
        if argv[:3] == ["gh", "run", "view"]:
            return 0, self.run_log
        if argv[:3] == ["gh", "run", "list"]:
            return 0, json.dumps([{"databaseId": 1234, "headSha": self.pr["headRefOid"], "status": "completed", "conclusion": "failure"}])
        if argv[:3] == ["gh", "pr", "diff"]:
            return self.diff_error, getattr(self, "diff_content", "diff --git a/src/app.ts b/src/app.ts\n+const clean = true;\n")
        if argv[:3] == ["gh", "pr", "checks"]:
            return 0, self.run_log or "continuous-integration   fail"
        raise AssertionError(f"Unexpected GitHub command: {argv}")
