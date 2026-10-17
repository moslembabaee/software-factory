#!/usr/bin/env python3
"""Git worktree manager for concurrent task isolation, conflict detection,
workspace cleanup, and baseline branch merge reconciliation.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable

import build_events
from command_runner import run_cmd

PROJECT_ROOT = Path(__file__).resolve().parent
DEFAULT_BASE_BRANCH = "main"
DEFAULT_WORKTREES_DIR = ".worktrees"

Runner = Callable[[list[str] | str, float, Path], tuple[int, str]]


@dataclass(frozen=True)
class Worktree:
    task_id: str
    path: Path
    branch: str
    base_ref: str
    created_at: str
    status: str = "active"


def timestamp() -> str:
    return datetime.now(timezone.utc).isoformat()


def get_task_branch_name(task_id: str, prefix: str = "factory") -> str:
    sanitized = re.sub(r"[^a-zA-Z0-9_\-\.]", "-", task_id).lower().strip("-")
    return f"{prefix}/{sanitized}"


def get_worktree_path(project_root: Path, task_id: str, worktree_dir: Path | None = None) -> Path:
    sanitized = re.sub(r"[^a-zA-Z0-9_\-\.]", "-", task_id).lower().strip("-")
    base = worktree_dir if worktree_dir is not None else (project_root / DEFAULT_WORKTREES_DIR)
    return base / sanitized


def parse_conflict_files(output: str) -> list[str]:
    files: set[str] = set()
    for m in re.finditer(r"CONFLICT\s+\([^)]+\):\s+Merge conflict in\s+(\S+)", output):
        files.add(m.group(1).strip("'\""))
    for m in re.finditer(r"CONFLICT\s+\([^)]+\):\s+(\S+)\s+(?:deleted|modified|was)", output):
        files.add(m.group(1).strip("'\""))
    for m in re.finditer(r"^\d+\s+[0-9a-f]{40}\s+[123]\t(.+)$", output, re.M):
        files.add(m.group(1).strip("'\""))
    for m in re.finditer(r"^(?:UU|AA|UD|DU|UA|AU)\s+(.+)$", output, re.M):
        files.add(m.group(1).strip("'\""))
    return sorted(files)


def create_worktree(
    project_root: Path,
    task_id: str,
    branch: str | None = None,
    base_ref: str = DEFAULT_BASE_BRANCH,
    worktree_dir: Path | None = None,
    runner: Runner = run_cmd,
    timeout: float = 60,
) -> tuple[bool, Path, str]:
    """Create an isolated git worktree for the task."""
    worktree_path = get_worktree_path(project_root, task_id, worktree_dir)
    branch_name = branch or get_task_branch_name(task_id)

    # Validate branch name
    code, out = runner(["git", "check-ref-format", "--branch", branch_name], timeout, project_root)
    if code != 0 or branch_name.startswith("-") or branch_name == "HEAD":
        return False, worktree_path, f"Invalid branch name: {branch_name}"

    worktree_path.parent.mkdir(parents=True, exist_ok=True)

    # If worktree directory already exists, clean it up before recreating
    if worktree_path.exists():
        remove_worktree(project_root, worktree_path, runner=runner, timeout=timeout)

    # Check if the branch already exists
    code_branch, _ = runner(
        ["git", "rev-parse", "--verify", f"refs/heads/{branch_name}"],
        timeout,
        project_root,
    )
    if code_branch == 0:
        # Branch exists: attach worktree to existing branch
        code, out = runner(
            ["git", "worktree", "add", str(worktree_path), branch_name],
            timeout,
            project_root,
        )
    else:
        # Create branch off base_ref
        code, out = runner(
            ["git", "worktree", "add", "-b", branch_name, str(worktree_path), base_ref],
            timeout,
            project_root,
        )

    if code != 0:
        return False, worktree_path, f"git worktree add failed ({code}): {out}"

    # Setup environment symlinks so tests and build tools execute seamlessly
    node_modules_src = project_root / "node_modules"
    node_modules_dest = worktree_path / "node_modules"
    if node_modules_src.exists() and not node_modules_dest.exists():
        try:
            os.symlink(node_modules_src, node_modules_dest)
        except OSError:
            pass

    env_src = project_root / ".env"
    env_dest = worktree_path / ".env"
    if env_src.exists() and not env_dest.exists():
        try:
            os.symlink(env_src, env_dest)
        except OSError:
            pass

    return True, worktree_path, "Worktree created successfully"


def remove_worktree(
    project_root: Path,
    worktree_path: Path,
    force: bool = True,
    delete_branch: bool = False,
    branch_name: str | None = None,
    runner: Runner = run_cmd,
    timeout: float = 60,
) -> tuple[bool, str]:
    """Clean up and remove an isolated worktree directory and prune git metadata."""
    if not worktree_path.exists():
        runner(["git", "worktree", "prune"], timeout, project_root)
        return True, "Worktree does not exist"

    # Safely remove symlinks before git worktree remove
    for symlink_name in ("node_modules", ".env"):
        p = worktree_path / symlink_name
        if p.is_symlink() or p.is_file():
            try:
                p.unlink(missing_ok=True)
            except OSError:
                pass

    cmd = ["git", "worktree", "remove"]
    if force:
        cmd.append("--force")
    cmd.append(str(worktree_path))

    code, out = runner(cmd, timeout, project_root)

    # If directory still lingers on disk, clean up with rmtree
    if worktree_path.exists():
        try:
            shutil.rmtree(worktree_path, ignore_errors=True)
        except Exception:
            pass

    # Prune worktree metadata in git
    runner(["git", "worktree", "prune"], timeout, project_root)

    if delete_branch and branch_name:
        runner(["git", "branch", "-D", branch_name], timeout, project_root)

    return True, "Worktree removed successfully"


def cleanup_worktree(
    project_root: Path,
    task_id: str,
    worktree_dir: Path | None = None,
    runner: Runner = run_cmd,
    timeout: float = 60,
) -> tuple[bool, str]:
    """Clean up a worktree identified by task ID."""
    path = get_worktree_path(project_root, task_id, worktree_dir)
    return remove_worktree(project_root, path, runner=runner, timeout=timeout)


def list_worktrees(
    project_root: Path, runner: Runner = run_cmd, timeout: float = 60,
) -> list[dict]:
    """List all git worktrees managed by the repository."""
    code, out = runner(["git", "worktree", "list", "--porcelain"], timeout, project_root)
    if code != 0:
        return []
    worktrees = []
    current: dict = {}
    for line in out.splitlines():
        line = line.strip()
        if not line:
            if current:
                worktrees.append(current)
                current = {}
            continue
        if line.startswith("worktree "):
            current["path"] = line.split(" ", 1)[1]
        elif line.startswith("HEAD "):
            current["head"] = line.split(" ", 1)[1]
        elif line.startswith("branch "):
            current["branch"] = line.split(" ", 1)[1]
        elif line == "bare":
            current["bare"] = True
        elif line == "detached":
            current["detached"] = True
    if current:
        worktrees.append(current)
    return worktrees


def cleanup_stale_worktrees(
    project_root: Path,
    active_task_ids: set[str],
    worktree_dir: Path | None = None,
    runner: Runner = run_cmd,
    timeout: float = 60,
) -> list[str]:
    """Prune any worktrees located in the worktrees directory that are no longer active."""
    cleaned = []
    w_dir = worktree_dir if worktree_dir is not None else (project_root / DEFAULT_WORKTREES_DIR)
    w_dir_str = str(w_dir.resolve())
    for wt in list_worktrees(project_root, runner, timeout):
        p = Path(wt.get("path", "")).resolve()
        if str(p).startswith(w_dir_str) and p.name not in active_task_ids:
            remove_worktree(project_root, p, runner=runner, timeout=timeout)
            cleaned.append(str(p))
    runner(["git", "worktree", "prune"], timeout, project_root)
    return cleaned


def detect_worktree_conflicts(
    project_root: Path,
    branch: str,
    base_branch: str = DEFAULT_BASE_BRANCH,
    runner: Runner = run_cmd,
    timeout: float = 60,
) -> dict:
    """Automated conflict detection between task branch and baseline branch."""
    code, out = runner(
        ["git", "merge-tree", "--write-tree", branch, base_branch],
        timeout,
        project_root,
    )
    if code != 0 or "CONFLICT" in out:
        conflicts = parse_conflict_files(out)
        err_msg = (
            f"Merge conflict in {len(conflicts)} file(s): {', '.join(conflicts[:5])}"
            if conflicts
            else "Merge conflict detected with baseline branch"
        )
        return {
            "has_conflict": True,
            "conflicting_files": conflicts,
            "base_branch": base_branch,
            "branch": branch,
            "error": err_msg,
        }
    return {
        "has_conflict": False,
        "conflicting_files": [],
        "base_branch": base_branch,
        "branch": branch,
        "error": None,
    }


def detect_parallel_conflicts(
    project_root: Path,
    branch_a: str,
    branch_b: str,
    base_branch: str = DEFAULT_BASE_BRANCH,
    runner: Runner = run_cmd,
    timeout: float = 60,
) -> dict:
    """Detect conflicts and overlapping modified files between two parallel task branches."""
    code_a, out_a = runner(["git", "diff", "--name-only", f"{base_branch}...{branch_a}"], timeout, project_root)
    code_b, out_b = runner(["git", "diff", "--name-only", f"{base_branch}...{branch_b}"], timeout, project_root)

    files_a = set(out_a.splitlines()) if code_a == 0 else set()
    files_b = set(out_b.splitlines()) if code_b == 0 else set()
    overlapping = sorted(files_a & files_b)

    code_mt, out_mt = runner(
        ["git", "merge-tree", "--write-tree", branch_a, branch_b],
        timeout,
        project_root,
    )
    has_conflict = code_mt != 0 or "CONFLICT" in out_mt
    conflicts = parse_conflict_files(out_mt) if has_conflict else []

    return {
        "has_conflict": has_conflict,
        "conflicting_files": conflicts,
        "overlapping_files": overlapping,
        "branch_a": branch_a,
        "branch_b": branch_b,
        "error": f"Conflict detected between parallel branches in: {', '.join(conflicts[:5])}" if conflicts else None,
    }


def reconcile_worktree_to_baseline(
    project_root: Path,
    task: dict,
    worktree_path: Path,
    base_branch: str = DEFAULT_BASE_BRANCH,
    remote: str = "origin",
    runner: Runner = run_cmd,
    timeout: float = 120,
) -> tuple[bool, dict]:
    """Reconcile verified task in worktree with baseline branch upon verification success.

    Steps:
    1. Commit any uncommitted changes in the worktree.
    2. Check if baseline branch has advanced.
    3. If behind, run automated conflict detection; if clean, rebase and re-verify in worktree.
    4. Reconcile / fast-forward baseline branch with task branch.
    """
    branch = task.get("branch") or get_task_branch_name(task["id"])

    # 1. Commit any remaining changes in worktree
    # Check for uncommitted or staged changes
    code_st, st_out = runner(["git", "status", "--porcelain"], timeout, worktree_path)
    if code_st == 0 and st_out.strip():
        # Exclude control files if any
        runner(["git", "add", "--all", "--", ".", ":(exclude)ROADMAP.json", ":(exclude)ROADMAP.md"], timeout, worktree_path)
        code_diff, _ = runner(["git", "diff", "--cached", "--quiet"], timeout, worktree_path)
        if code_diff == 1:
            code_c, c_out = runner(
                ["git", "-c", "commit.gpgsign=false", "commit", "-m", f"feat({task['id']}): {task['title']}"],
                timeout,
                worktree_path,
            )
            if code_c != 0:
                return False, {"success": False, "has_conflict": False, "error": f"git commit failed in worktree: {c_out}"}

    code_sha, sha_out = runner(["git", "rev-parse", "HEAD"], timeout, worktree_path)
    if code_sha != 0 or not sha_out.strip():
        return False, {"success": False, "has_conflict": False, "error": f"Cannot resolve worktree commit SHA: {sha_out}"}
    current_sha = sha_out.strip()

    # 2. Check if branch is behind base_branch
    code_base, base_sha = runner(["git", "rev-parse", base_branch], timeout, project_root)
    code_mb, mb_sha = runner(["git", "merge-base", branch, base_branch], timeout, project_root)
    is_behind = (
        code_base == 0
        and code_mb == 0
        and base_sha.strip()
        and mb_sha.strip()
        and base_sha.strip() != mb_sha.strip()
    )

    if is_behind:
        # Automated conflict detection
        conflict_check = detect_worktree_conflicts(project_root, branch, base_branch, runner=runner, timeout=timeout)
        if conflict_check["has_conflict"]:
            return False, {
                "success": False,
                "has_conflict": True,
                "conflicting_files": conflict_check["conflicting_files"],
                "base_branch": base_branch,
                "branch": branch,
                "error": conflict_check["error"],
            }

        # Rebase onto base_branch inside worktree
        code_reb, reb_out = runner(
            ["git", "-c", "commit.gpgsign=false", "rebase", "--autostash", base_branch],
            timeout,
            worktree_path,
        )
        if code_reb != 0:
            runner(["git", "rebase", "--abort"], timeout, worktree_path)
            conflicts = parse_conflict_files(reb_out)
            return False, {
                "success": False,
                "has_conflict": True,
                "conflicting_files": conflicts,
                "base_branch": base_branch,
                "branch": branch,
                "error": f"Rebase failed during baseline reconciliation: {reb_out}",
            }

        code_new_sha, new_sha_out = runner(["git", "rev-parse", "HEAD"], timeout, worktree_path)
        if code_new_sha == 0 and new_sha_out.strip():
            current_sha = new_sha_out.strip()

        # Re-verify task inside worktree
        verif_cmd = task.get("verification_cmd")
        if verif_cmd and str(verif_cmd).strip():
            vcode, vout = runner(str(verif_cmd).strip(), timeout, worktree_path)
            if vcode != 0:
                return False, {
                    "success": False,
                    "has_conflict": False,
                    "reverified": True,
                    "verification_passed": False,
                    "rebased_sha": current_sha,
                    "error": f"Re-verification failed after baseline rebase ({vcode}): {vout[-500:]}",
                }

    # 3. Merge or fast-forward into baseline branch in project_root if project_root is on base_branch
    code_curr, curr_branch = runner(["git", "branch", "--show-current"], timeout, project_root)
    if code_curr == 0 and curr_branch.strip() == base_branch:
        runner(["git", "merge", "--ff-only", branch], timeout, project_root)

    return True, {
        "success": True,
        "reconciled_sha": current_sha,
        "branch": branch,
        "base_branch": base_branch,
        "has_conflict": False,
        "conflicting_files": [],
        "reverified": is_behind,
        "verification_passed": True,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command")

    subparsers.add_parser("list", help="List active worktrees")

    clean_parser = subparsers.add_parser("clean", help="Clean up stale worktrees")
    clean_parser.add_argument("--project-root", type=Path, default=PROJECT_ROOT)

    conflict_parser = subparsers.add_parser("conflicts", help="Detect branch conflicts")
    conflict_parser.add_argument("branch", help="Task branch name")
    conflict_parser.add_argument("--base", default=DEFAULT_BASE_BRANCH, help="Baseline branch")
    conflict_parser.add_argument("--project-root", type=Path, default=PROJECT_ROOT)

    args = parser.parse_args()
    if args.command == "list":
        for wt in list_worktrees(PROJECT_ROOT):
            print(f"{wt.get('path')} [{wt.get('branch', 'detached')}] ({wt.get('head', '')})")
    elif args.command == "clean":
        cleaned = cleanup_stale_worktrees(args.project_root, set())
        print(f"Cleaned {len(cleaned)} stale worktree(s)")
    elif args.command == "conflicts":
        res = detect_worktree_conflicts(args.project_root, args.branch, args.base)
        print(json.dumps(res, indent=2))
    else:
        parser.print_help()


if __name__ == "__main__":
    main()
