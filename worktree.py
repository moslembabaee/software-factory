#!/usr/bin/env python3
"""Isolated Git Worktree Management, Automated Conflict Detection, and Merge Reconciliation."""

from __future__ import annotations

import argparse
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import re
import shutil
import sys
import time
from typing import Callable, Sequence

from command_runner import run_cmd

PROJECT_ROOT = Path(__file__).resolve().parent


def timestamp() -> str:
    return datetime.now(timezone.utc).isoformat()


def sanitize_task_id(task_id: str) -> str:
    sanitized = re.sub(r"[^a-zA-Z0-9-]+", "-", task_id).strip("-").lower()[:120]
    return sanitized or "task"


def parse_conflict_files(output: str) -> list[str]:
    """Parse conflicting file paths from git merge or merge-tree output."""
    files: set[str] = set()
    for m in re.finditer(r"CONFLICT\s+\([^)]+\):\s+Merge conflict in\s+(\S+)", output):
        files.add(m.group(1))
    for m in re.finditer(r"conflict in (\S+)", output, re.IGNORECASE):
        files.add(m.group(1))
    return sorted(files)


@dataclass(frozen=True)
class WorktreeInfo:
    task_id: str
    path: Path
    branch: str
    base_branch: str = "main"
    created_at: str = ""
    head_sha: str = ""
    status: str = "active"

    def to_dict(self) -> dict:
        data = asdict(self)
        data["path"] = str(self.path)
        return data


@dataclass(frozen=True)
class ConflictDetectionResult:
    has_conflict: bool
    conflicting_files: list[str] = field(default_factory=list)
    base_branch: str = "main"
    task_branch: str = ""
    overlapping_tasks: list[str] = field(default_factory=list)
    error: str | None = None

    def to_dict(self) -> dict:
        return asdict(self)


@dataclass(frozen=True)
class MergeReconciliationResult:
    success: bool
    task_id: str
    merged_sha: str = ""
    base_branch: str = "main"
    task_branch: str = ""
    conflict_detected: bool = False
    conflicting_files: list[str] = field(default_factory=list)
    error: str | None = None
    cleaned_up: bool = False
    timestamp: str = ""

    def to_dict(self) -> dict:
        return asdict(self)


@dataclass(frozen=True)
class WorktreeCleanupResult:
    success: bool
    task_id: str
    path: str
    branch_deleted: bool = False
    error: str | None = None

    def to_dict(self) -> dict:
        return asdict(self)


class WorktreeManager:
    def __init__(
        self,
        project_root: Path = PROJECT_ROOT,
        worktree_dir: Path | None = None,
        base_branch: str = "main",
        branch_prefix: str = "factory",
        runner: Callable = run_cmd,
        timeout: float = 60,
    ) -> None:
        self.project_root = Path(project_root).resolve()
        self.worktree_dir = (
            Path(worktree_dir).resolve() if worktree_dir else self.project_root / ".worktrees"
        )
        self.base_branch = base_branch
        self.branch_prefix = branch_prefix
        self.runner = runner
        self.timeout = timeout

    def get_worktree_path(self, task_id: str) -> Path:
        return self.worktree_dir / f"task-{sanitize_task_id(task_id)}"

    def get_task_branch(self, task_id: str) -> str:
        return f"{self.branch_prefix}/{sanitize_task_id(task_id)}"

    def create_worktree(
        self,
        task_id: str,
        base_branch: str | None = None,
        branch: str | None = None,
    ) -> WorktreeInfo:
        """Create an isolated git worktree for a task based on base_branch."""
        base = base_branch or self.base_branch
        task_branch = branch or self.get_task_branch(task_id)
        target_path = self.get_worktree_path(task_id)

        # 1. Ensure worktree root directory exists and is gitignored
        self.worktree_dir.mkdir(parents=True, exist_ok=True)
        gitignore = self.project_root / ".gitignore"
        rel_dir = ".worktrees"
        try:
            if gitignore.exists():
                gi_content = gitignore.read_text(encoding="utf-8")
                if rel_dir not in gi_content and f"{rel_dir}/" not in gi_content:
                    gitignore.write_text(gi_content.rstrip() + f"\n{rel_dir}/\n", encoding="utf-8")
        except OSError:
            pass

        # 2. If worktree already exists, remove it cleanly first
        if target_path.exists():
            self.cleanup_worktree(task_id, delete_branch=False)

        # 3. Add git worktree with branch
        cmd = ["git", "worktree", "add", "-B", task_branch, str(target_path), base]
        code, out = self.runner(cmd, self.timeout, self.project_root)
        if code != 0:
            raise RuntimeError(f"git worktree add failed ({code}): {out}")

        # 4. Get HEAD SHA of worktree
        code, sha_out = self.runner(["git", "rev-parse", "HEAD"], self.timeout, target_path)
        head_sha = sha_out.strip() if code == 0 else ""

        # 5. Sync necessary local files into the worktree
        for fname in ("ROADMAP.json", "maintainers.json"):
            src = self.project_root / fname
            dst = target_path / fname
            if src.exists() and not dst.exists():
                try:
                    shutil.copy2(src, dst)
                except OSError:
                    pass

        return WorktreeInfo(
            task_id=task_id,
            path=target_path,
            branch=task_branch,
            base_branch=base,
            created_at=timestamp(),
            head_sha=head_sha,
            status="active",
        )

    def list_worktrees(self) -> list[WorktreeInfo]:
        """List active git worktrees using git worktree list --porcelain."""
        code, out = self.runner(["git", "worktree", "list", "--porcelain"], self.timeout, self.project_root)
        if code != 0 or not out.strip():
            return []

        worktrees: list[WorktreeInfo] = []
        entries = out.strip().split("\n\n")

        for entry in entries:
            if not entry.strip():
                continue
            path_str = ""
            head_sha = ""
            branch_str = ""

            for raw_line in entry.splitlines():
                line = raw_line.strip()
                if line.startswith("worktree "):
                    path_str = line[len("worktree "):].strip()
                elif line.startswith("HEAD "):
                    head_sha = line[len("HEAD "):].strip()
                elif line.startswith("branch "):
                    full_ref = line[len("branch "):].strip()
                    branch_str = re.sub(r"^refs/heads/", "", full_ref)

            if path_str:
                p = Path(path_str).resolve()
                last_part = p.name
                task_id = re.sub(r"^(?:worktree-|task-)", "", last_part) or branch_str or "main"
                worktrees.append(
                    WorktreeInfo(
                        task_id=task_id,
                        path=p,
                        branch=branch_str or "detached",
                        base_branch=self.base_branch,
                        created_at=timestamp(),
                        head_sha=head_sha,
                        status="active",
                    )
                )

        return worktrees

    def detect_conflicts(
        self,
        task_id: str,
        base_branch: str | None = None,
        branch: str | None = None,
    ) -> ConflictDetectionResult:
        """Detect merge conflicts between the task branch and base_branch."""
        base = base_branch or self.base_branch
        task_branch = branch or self.get_task_branch(task_id)

        # Use git merge-tree --write-tree
        cmd = ["git", "merge-tree", "--write-tree", task_branch, base]
        code, out = self.runner(cmd, self.timeout, self.project_root)

        if code != 0 or "CONFLICT" in out:
            conflicts = parse_conflict_files(out)
            err_msg = (
                f"Merge conflict in {len(conflicts)} file(s): {', '.join(conflicts[:5])}"
                if conflicts
                else f"Merge conflict detected between {task_branch} and {base}"
            )
            return ConflictDetectionResult(
                has_conflict=True,
                conflicting_files=conflicts,
                base_branch=base,
                task_branch=task_branch,
                overlapping_tasks=[],
                error=err_msg,
            )

        return ConflictDetectionResult(
            has_conflict=False,
            conflicting_files=[],
            base_branch=base,
            task_branch=task_branch,
            overlapping_tasks=[],
            error=None,
        )

    def detect_concurrent_conflicts(
        self,
        task_ids: Sequence[str],
        base_branch: str | None = None,
    ) -> dict[str, list[str]]:
        """Detect file modification overlaps between concurrent worktrees."""
        base = base_branch or self.base_branch
        task_files: dict[str, set[str]] = {}

        for tid in task_ids:
            tb = self.get_task_branch(tid)
            code, out = self.runner(["git", "diff", "--name-only", f"{base}...{tb}"], self.timeout, self.project_root)
            if code == 0:
                files = {line.strip() for line in out.splitlines() if line.strip()}
                task_files[tid] = files

        conflicts: dict[str, list[str]] = {}
        id_list = list(task_ids)
        for i, t1 in enumerate(id_list):
            for t2 in id_list[i + 1:]:
                overlap = task_files.get(t1, set()) & task_files.get(t2, set())
                if overlap:
                    overlap_list = sorted(overlap)
                    conflicts.setdefault(t1, []).append(f"Overlaps with {t2} on: {', '.join(overlap_list)}")
                    conflicts.setdefault(t2, []).append(f"Overlaps with {t1} on: {', '.join(overlap_list)}")

        return conflicts

    def reconcile_and_merge(
        self,
        task_id: str,
        commit_message: str | None = None,
        base_branch: str | None = None,
        branch: str | None = None,
        cleanup: bool = True,
    ) -> MergeReconciliationResult:
        """Automated conflict detection and baseline branch merge reconciliation."""
        base = base_branch or self.base_branch
        task_branch = branch or self.get_task_branch(task_id)
        now_str = timestamp()

        # 1. Automated conflict detection
        conflict = self.detect_conflicts(task_id, base_branch=base, branch=task_branch)
        if conflict.has_conflict:
            return MergeReconciliationResult(
                success=False,
                task_id=task_id,
                base_branch=base,
                task_branch=task_branch,
                conflict_detected=True,
                conflicting_files=conflict.conflicting_files,
                error=conflict.error,
                cleaned_up=False,
                timestamp=now_str,
            )

        # 2. Ensure baseline branch is checked out in project_root
        code, current_branch_out = self.runner(["git", "branch", "--show-current"], self.timeout, self.project_root)
        current_branch = current_branch_out.strip()
        if current_branch != base:
            code, out = self.runner(["git", "checkout", base], self.timeout, self.project_root)
            if code != 0:
                return MergeReconciliationResult(
                    success=False,
                    task_id=task_id,
                    base_branch=base,
                    task_branch=task_branch,
                    error=f"Cannot checkout base branch {base}: {out}",
                    timestamp=now_str,
                )

        # 3. Perform merge into baseline branch
        msg = commit_message or f"feat({task_id}): Reconcile worktree task into {base}"
        merge_cmd = ["git", "merge", "--no-ff", "-m", msg, task_branch]
        code, out = self.runner(merge_cmd, self.timeout, self.project_root)
        if code != 0:
            # Abort failed merge to preserve clean baseline
            self.runner(["git", "merge", "--abort"], self.timeout, self.project_root)
            return MergeReconciliationResult(
                success=False,
                task_id=task_id,
                base_branch=base,
                task_branch=task_branch,
                conflict_detected=True,
                error=f"Merge into {base} failed ({code}): {out}",
                timestamp=now_str,
            )

        # 4. Get new baseline HEAD SHA
        code, sha_out = self.runner(["git", "rev-parse", "HEAD"], self.timeout, self.project_root)
        merged_sha = sha_out.strip() if code == 0 else ""

        # 5. Cleanup worktree if requested
        cleaned = False
        if cleanup:
            cleanup_res = self.cleanup_worktree(task_id, delete_branch=False)
            cleaned = cleanup_res.success

        return MergeReconciliationResult(
            success=True,
            task_id=task_id,
            merged_sha=merged_sha,
            base_branch=base,
            task_branch=task_branch,
            conflict_detected=False,
            conflicting_files=[],
            cleaned_up=cleaned,
            timestamp=now_str,
        )

    def cleanup_worktree(
        self,
        task_id: str,
        delete_branch: bool = False,
    ) -> WorktreeCleanupResult:
        """Remove worktree directory and prune git worktree registry."""
        target_path = self.get_worktree_path(task_id)
        task_branch = self.get_task_branch(task_id)
        err = None

        # 1. Run git worktree remove
        if target_path.exists():
            code, out = self.runner(
                ["git", "worktree", "remove", "--force", str(target_path)],
                self.timeout,
                self.project_root,
            )
            if code != 0:
                err = f"git worktree remove failed: {out}"

        # 2. Run git worktree prune
        self.runner(["git", "worktree", "prune"], self.timeout, self.project_root)

        # 3. Clean remaining directory if still present
        if target_path.exists():
            try:
                shutil.rmtree(target_path, ignore_errors=True)
            except OSError as ex:
                err = err or str(ex)

        # 4. Delete branch if requested
        branch_deleted = False
        if delete_branch:
            code, _ = self.runner(["git", "branch", "-D", task_branch], self.timeout, self.project_root)
            branch_deleted = (code == 0)

        return WorktreeCleanupResult(
            success=not target_path.exists(),
            task_id=task_id,
            path=str(target_path),
            branch_deleted=branch_deleted,
            error=err,
        )

    def cleanup_stale_worktrees(
        self,
        active_task_ids: Sequence[str] | None = None,
    ) -> list[str]:
        """Clean up all worktrees not in the active_task_ids list."""
        active = {sanitize_task_id(t) for t in (active_task_ids or [])}
        cleaned: list[str] = []

        if not self.worktree_dir.exists():
            return cleaned

        for child in self.worktree_dir.iterdir():
            if child.is_dir() and (child.name.startswith("task-") or child.name.startswith("worktree-")):
                tid = sanitize_task_id(re.sub(r"^(?:task-|worktree-)", "", child.name))
                if tid not in active:
                    res = self.cleanup_worktree(tid)
                    if res.success:
                        cleaned.append(tid)

        self.runner(["git", "worktree", "prune"], self.timeout, self.project_root)
        return cleaned


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--create", metavar="TASK_ID", help="Create isolated worktree for task")
    parser.add_argument("--cleanup", metavar="TASK_ID", help="Clean up worktree for task")
    parser.add_argument("--list", action="store_true", help="List active worktrees")
    parser.add_argument("--detect-conflict", metavar="TASK_ID", help="Detect conflicts with base branch")
    parser.add_argument("--reconcile", metavar="TASK_ID", help="Reconcile and merge worktree into base branch")
    parser.add_argument("--base-branch", default="main", help="Baseline branch name")
    parser.add_argument("--project-root", type=Path, default=PROJECT_ROOT)
    args = parser.parse_args()

    manager = WorktreeManager(args.project_root.resolve(), base_branch=args.base_branch)

    if args.create:
        info = manager.create_worktree(args.create)
        print(json.dumps(info.to_dict(), indent=2))
        sys.exit(0)

    if args.cleanup:
        res = manager.cleanup_worktree(args.cleanup)
        print(json.dumps(res.to_dict(), indent=2))
        sys.exit(0 if res.success else 1)

    if args.list:
        wt_list = [w.to_dict() for w in manager.list_worktrees()]
        print(json.dumps(wt_list, indent=2))
        sys.exit(0)

    if args.detect_conflict:
        res = manager.detect_conflicts(args.detect_conflict)
        print(json.dumps(res.to_dict(), indent=2))
        sys.exit(1 if res.has_conflict else 0)

    if args.reconcile:
        res = manager.reconcile_and_merge(args.reconcile)
        print(json.dumps(res.to_dict(), indent=2))
        sys.exit(0 if res.success else 1)

    parser.print_help()


if __name__ == "__main__":
    main()
