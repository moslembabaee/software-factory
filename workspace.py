#!/usr/bin/env python3
"""Self-healing workspace rollback and state drift reconciliation for Software Factory."""

from __future__ import annotations

import argparse
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import re
import sys
import tempfile
import time
from typing import Callable, Sequence

from command_runner import run_cmd
import roadmap_store

PROJECT_ROOT = Path(__file__).resolve().parent


@dataclass
class WorkspaceFileChange:
    path: str
    status: str  # modified, added, deleted, untracked, conflict
    staged: bool
    orig_path: str | None = None

    def to_dict(self) -> dict:
        return asdict(self)


@dataclass
class WorkspaceCleanliness:
    clean: bool
    modified_files: list[str] = field(default_factory=list)
    untracked_files: list[str] = field(default_factory=list)
    staged_files: list[str] = field(default_factory=list)
    deleted_files: list[str] = field(default_factory=list)
    conflict_files: list[str] = field(default_factory=list)
    has_index_lock: bool = False
    branch: str = "main"
    head_sha: str = ""
    summary: str = "Workspace is clean"

    def to_dict(self) -> dict:
        return asdict(self)


@dataclass
class WorkspaceCheckpoint:
    id: str
    timestamp: str
    task_id: str | None
    commit_sha: str
    branch: str
    roadmap_backup_path: str | None = None
    cleanliness: WorkspaceCleanliness | None = None

    def to_dict(self) -> dict:
        data = asdict(self)
        if self.cleanliness:
            data["cleanliness"] = self.cleanliness.to_dict()
        return data


@dataclass
class RollbackResult:
    success: bool
    strategy: str
    reason: str
    previous_head: str
    restored_head: str
    cleaned_files: list[str] = field(default_factory=list)
    restored_files: list[str] = field(default_factory=list)
    roadmap_restored: bool = False
    timestamp: str = ""
    error: str | None = None

    def to_dict(self) -> dict:
        return asdict(self)


@dataclass
class DriftReconciliationResult:
    reconciled: bool
    actions_applied: list[str] = field(default_factory=list)
    restored_roadmap: bool = False
    previous_current_task_id: str | None = None
    new_current_task_id: str | None = None
    summary: str = "No drift detected"

    def to_dict(self) -> dict:
        return asdict(self)


def parse_status_porcelain(
    porcelain_output: str,
    branch: str = "main",
    head_sha: str = "",
    has_index_lock: bool = False,
) -> WorkspaceCleanliness:
    """Parse git status --porcelain output into structured WorkspaceCleanliness."""
    modified_files: list[str] = []
    untracked_files: list[str] = []
    staged_files: list[str] = []
    deleted_files: list[str] = []
    conflict_files: list[str] = []

    for raw_line in porcelain_output.splitlines():
        if not raw_line or not raw_line.strip():
            continue
        line = raw_line
        x = line[0] if len(line) > 0 else " "
        y = line[1] if len(line) > 1 else " "
        path_part = line[3:].strip()
        if not path_part:
            continue

        path = path_part
        if " -> " in path_part:
            parts = path_part.split(" -> ")
            path = parts[1]

        # Merge conflicts
        if (x == "U" or y == "U") or (x == "A" and y == "A") or (x == "D" and y == "D"):
            conflict_files.append(path)
            continue

        # Untracked
        if x == "?" and y == "?":
            untracked_files.append(path)
            continue

        # Staged
        if x not in (" ", "?"):
            staged_files.append(path)
            if x == "D":
                deleted_files.append(path)
            elif x in ("M", "A", "R", "C") and path not in modified_files:
                modified_files.append(path)

        # Unstaged
        if y not in (" ", "?"):
            if y == "D" and path not in deleted_files:
                deleted_files.append(path)
            elif path not in modified_files:
                modified_files.append(path)

    is_clean = (
        len(modified_files) == 0
        and len(untracked_files) == 0
        and len(staged_files) == 0
        and len(deleted_files) == 0
        and len(conflict_files) == 0
        and not has_index_lock
    )

    summary_parts: list[str] = []
    if modified_files:
        summary_parts.append(f"{len(modified_files)} modified")
    if untracked_files:
        summary_parts.append(f"{len(untracked_files)} untracked")
    if staged_files:
        summary_parts.append(f"{len(staged_files)} staged")
    if deleted_files:
        summary_parts.append(f"{len(deleted_files)} deleted")
    if conflict_files:
        summary_parts.append(f"{len(conflict_files)} conflicted")
    if has_index_lock:
        summary_parts.append("index.lock present")

    summary = "Workspace is clean" if is_clean else f"Workspace dirty: {', '.join(summary_parts)}"

    return WorkspaceCleanliness(
        clean=is_clean,
        modified_files=modified_files,
        untracked_files=untracked_files,
        staged_files=staged_files,
        deleted_files=deleted_files,
        conflict_files=conflict_files,
        has_index_lock=has_index_lock,
        branch=branch,
        head_sha=head_sha,
        summary=summary,
    )


def validate_workspace_cleanliness(
    project_root: Path,
    runner: Callable = run_cmd,
) -> WorkspaceCleanliness:
    """Validate workspace cleanliness by inspecting git status and git lockfiles."""
    root = Path(project_root).resolve()
    git_dir = root / ".git"

    # Check for stale index.lock
    index_lock = git_dir / "index.lock"
    has_lock = False
    if index_lock.exists():
        # Check if lockfile is stale (older than 10 seconds)
        try:
            mtime = index_lock.stat().st_mtime
            if time.time() - mtime > 10:
                has_lock = True
        except OSError:
            has_lock = index_lock.exists()

    code, branch_out = runner(["git", "branch", "--show-current"], timeout=10, cwd=root)
    branch = branch_out.strip() if code == 0 and branch_out.strip() else "main"

    code, sha_out = runner(["git", "rev-parse", "HEAD"], timeout=10, cwd=root)
    head_sha = sha_out.strip() if code == 0 else ""

    code, status_out = runner(["git", "status", "--porcelain"], timeout=15, cwd=root)
    status_text = status_out if code == 0 else ""

    return parse_status_porcelain(
        status_text,
        branch=branch,
        head_sha=head_sha,
        has_index_lock=has_lock,
    )


def create_checkpoint(
    project_root: Path,
    task_id: str | None = None,
    runner: Callable = run_cmd,
) -> WorkspaceCheckpoint:
    """Create a persistent workspace checkpoint capturing git commit and roadmap state."""
    root = Path(project_root).resolve()
    cleanliness = validate_workspace_cleanliness(root, runner=runner)

    checkpoint_id = f"chk-{int(time.time())}-{os.urandom(3).hex()}"
    ts = datetime.now(timezone.utc).isoformat()

    # Backup ROADMAP.json if it exists
    roadmap_path = root / "ROADMAP.json"
    backup_file = None
    if roadmap_path.exists():
        checkpoints_dir = root / "logs" / "checkpoints"
        try:
            checkpoints_dir.mkdir(parents=True, exist_ok=True)
            target = checkpoints_dir / f"{checkpoint_id}-ROADMAP.json"
            target.write_text(roadmap_path.read_text(encoding="utf-8"), encoding="utf-8")
            backup_file = str(target)
        except OSError:
            pass

    return WorkspaceCheckpoint(
        id=checkpoint_id,
        timestamp=ts,
        task_id=task_id,
        commit_sha=cleanliness.head_sha,
        branch=cleanliness.branch,
        roadmap_backup_path=backup_file,
        cleanliness=cleanliness,
    )


def rollback_workspace(
    project_root: Path,
    checkpoint: WorkspaceCheckpoint | None = None,
    target_sha: str | None = None,
    clean_untracked: bool = True,
    restore_roadmap: bool = True,
    runner: Callable = run_cmd,
    reason: str = "unrecoverable_failure",
) -> RollbackResult:
    """Restore working directory and roadmap to stable checkpoint or HEAD cleanly."""
    root = Path(project_root).resolve()
    now_str = datetime.now(timezone.utc).isoformat()

    prev_cleanliness = validate_workspace_cleanliness(root, runner=runner)
    prev_head = prev_cleanliness.head_sha

    sha = target_sha or (checkpoint.commit_sha if checkpoint else prev_head)
    if not sha:
        sha = "HEAD"

    # 1. Remove stale git index lock if present
    lock_file = root / ".git" / "index.lock"
    if lock_file.exists():
        try:
            lock_file.unlink()
        except OSError:
            pass

    cleaned_files = list(prev_cleanliness.untracked_files)
    restored_files = list(prev_cleanliness.modified_files) + list(prev_cleanliness.deleted_files)

    # 2. Pre-read roadmap backup before git reset or git clean removes untracked files
    backup_roadmap_content = None
    current_roadmap_content = None
    if restore_roadmap and checkpoint and checkpoint.roadmap_backup_path:
        bak_path = Path(checkpoint.roadmap_backup_path)
        if bak_path.exists():
            try:
                content = bak_path.read_text(encoding="utf-8")
                json.loads(content)
                backup_roadmap_content = content
            except (json.JSONDecodeError, OSError):
                pass
    elif not restore_roadmap:
        target_roadmap = root / "ROADMAP.json"
        if target_roadmap.exists():
            try:
                current_roadmap_content = target_roadmap.read_text(encoding="utf-8")
            except OSError:
                pass

    # 3. Hard reset to target SHA
    reset_code, reset_out = runner(["git", "reset", "--hard", sha], timeout=30, cwd=root)
    if reset_code != 0:
        return RollbackResult(
            success=False,
            strategy="hard_reset",
            reason=reason,
            previous_head=prev_head,
            restored_head=prev_head,
            cleaned_files=[],
            restored_files=[],
            roadmap_restored=False,
            timestamp=now_str,
            error=f"git reset --hard {sha} failed: {reset_out}",
        )

    # 4. Clean untracked files
    if clean_untracked:
        clean_code, clean_out = runner(["git", "clean", "-fd"], timeout=30, cwd=root)
        if clean_code != 0:
            return RollbackResult(
                success=False,
                strategy="clean_untracked",
                reason=reason,
                previous_head=prev_head,
                restored_head=sha,
                cleaned_files=[],
                restored_files=restored_files,
                roadmap_restored=False,
                timestamp=now_str,
                error=f"git clean -fd failed: {clean_out}",
            )

    # 5. Restore roadmap from checkpoint if requested and available, or preserve current roadmap
    roadmap_restored = False
    if backup_roadmap_content is not None:
        try:
            target_roadmap = root / "ROADMAP.json"
            target_roadmap.write_text(backup_roadmap_content, encoding="utf-8")
            roadmap_restored = True
        except OSError:
            pass
    elif not restore_roadmap and current_roadmap_content is not None:
        try:
            target_roadmap = root / "ROADMAP.json"
            target_roadmap.write_text(current_roadmap_content, encoding="utf-8")
        except OSError:
            pass

    post_cleanliness = validate_workspace_cleanliness(root, runner=runner)

    return RollbackResult(
        success=post_cleanliness.clean or len(post_cleanliness.modified_files) == 0,
        strategy="restore_checkpoint" if roadmap_restored else "hard_reset",
        reason=reason,
        previous_head=prev_head,
        restored_head=post_cleanliness.head_sha or sha,
        cleaned_files=cleaned_files,
        restored_files=restored_files,
        roadmap_restored=roadmap_restored,
        timestamp=now_str,
    )


def detect_roadmap_corruption(roadmap_path: Path) -> tuple[bool, str | None]:
    """Check if ROADMAP.json is corrupted or unparseable. Returns (is_corrupt, error_detail)."""
    if not roadmap_path.exists():
        return True, "ROADMAP.json does not exist"

    try:
        content = roadmap_path.read_text(encoding="utf-8")
        if not content.strip():
            return True, "ROADMAP.json is empty"
        data = json.loads(content)
        if not isinstance(data, dict):
            return True, "ROADMAP.json root is not an object"
        if "tasks" not in data or not isinstance(data["tasks"], list):
            return True, "ROADMAP.json missing tasks array"
        return False, None
    except json.JSONDecodeError as err:
        return True, f"JSON decode error: {err}"
    except OSError as err:
        return True, f"File read error: {err}"


def reconcile_workspace_drift(
    project_root: Path,
    runner: Callable = run_cmd,
    max_retries: int = 3,
) -> DriftReconciliationResult:
    """Detect and heal roadmap corruption, orphaned execution states, and workspace drift."""
    root = Path(project_root).resolve()
    roadmap_path = root / "ROADMAP.json"
    actions: list[str] = []
    restored_roadmap = False

    is_corrupt, corrupt_detail = detect_roadmap_corruption(roadmap_path)
    if is_corrupt:
        # Attempt recovery from backup or git HEAD
        recovered = False
        # 1. Try checkpoints directory
        checkpoints_dir = root / "logs" / "checkpoints"
        if checkpoints_dir.exists():
            candidates = sorted(checkpoints_dir.glob("*-ROADMAP.json"), reverse=True)
            for c in candidates:
                try:
                    c_data = json.loads(c.read_text(encoding="utf-8"))
                    if isinstance(c_data, dict) and isinstance(c_data.get("tasks"), list):
                        roadmap_path.write_text(json.dumps(c_data, indent=2), encoding="utf-8")
                        actions.append(f"Restored corrupted ROADMAP.json from checkpoint: {c.name}")
                        recovered = True
                        restored_roadmap = True
                        break
                except (json.JSONDecodeError, OSError):
                    continue

        # 2. Try git show HEAD:ROADMAP.json
        if not recovered:
            code, git_roadmap = runner(["git", "show", "HEAD:ROADMAP.json"], timeout=15, cwd=root)
            if code == 0 and git_roadmap.strip():
                try:
                    g_data = json.loads(git_roadmap)
                    if isinstance(g_data, dict) and isinstance(g_data.get("tasks"), list):
                        roadmap_path.write_text(json.dumps(g_data, indent=2), encoding="utf-8")
                        actions.append("Restored corrupted ROADMAP.json from git HEAD:ROADMAP.json")
                        recovered = True
                        restored_roadmap = True
                except (json.JSONDecodeError, OSError):
                    pass

        if not recovered:
            return DriftReconciliationResult(
                reconciled=False,
                actions_applied=actions,
                restored_roadmap=False,
                summary=f"Unrecoverable roadmap corruption: {corrupt_detail}",
            )

    # Now load and inspect roadmap state
    try:
        data = json.loads(roadmap_path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError) as err:
        return DriftReconciliationResult(
            reconciled=False,
            actions_applied=actions,
            summary=f"Failed to read restored roadmap: {err}",
        )

    tasks = data.get("tasks", [])
    task_map = {t["id"]: t for t in tasks if isinstance(t, dict) and "id" in t}
    prev_current = data.get("current_task_id")
    new_current = prev_current

    # Check orphaned current_task_id
    if prev_current:
        cur_task = task_map.get(prev_current)
        if not cur_task:
            data["current_task_id"] = None
            new_current = None
            actions.append(f"Cleared orphaned current_task_id '{prev_current}' (task does not exist)")
        elif cur_task.get("status") in ("completed", "cancelled"):
            data["current_task_id"] = None
            new_current = None
            actions.append(
                f"Cleared current_task_id '{prev_current}' because task is already {cur_task.get('status')}"
            )

    # Reconcile stale or stuck in_progress tasks
    for t in tasks:
        t_id = t.get("id")
        t_status = t.get("status")
        t_retries = t.get("retry_count", 0)

        # If a task is in_progress but not current_task_id
        if t_status == "in_progress" and t_id != new_current:
            t["status"] = "approved"
            t.pop("active_attempt", None)
            actions.append(f"Reset abandoned in_progress task '{t_id}' to approved")

        # If task exceeded max retries and is still pending/approved/in_progress
        if t_retries >= max_retries and t_status in ("approved", "in_progress"):
            t["status"] = "failed"
            t["last_error"] = f"Reconciled: exceeded maximum retries ({t_retries}/{max_retries})"
            t.pop("active_attempt", None)
            actions.append(f"Marked task '{t_id}' as failed (exceeded {max_retries} retries)")

    if actions:
        try:
            def apply_reconciliation(latest):
                latest["current_task_id"] = data["current_task_id"]
                latest["tasks"] = data["tasks"]
                return True
            roadmap_store.update_roadmap(roadmap_path, apply_reconciliation)
        except Exception:
            roadmap_path.write_text(json.dumps(data, indent=2), encoding="utf-8")

    return DriftReconciliationResult(
        reconciled=len(actions) > 0,
        actions_applied=actions,
        restored_roadmap=restored_roadmap,
        previous_current_task_id=prev_current,
        new_current_task_id=new_current,
        summary=f"Reconciled {len(actions)} drift issue(s): {'; '.join(actions)}" if actions else "Workspace and roadmap are in sync",
    )


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="Validate workspace cleanliness")
    parser.add_argument("--rollback", action="store_true", help="Execute automated rollback to clean checkpoint")
    parser.add_argument("--reconcile", action="store_true", help="Reconcile roadmap corruption and state drift")
    parser.add_argument("--sha", default=None, help="Target commit SHA for rollback")
    parser.add_argument("--project-root", type=Path, default=PROJECT_ROOT)
    args = parser.parse_args()

    root = args.project_root.resolve()

    if args.check:
        cleanliness = validate_workspace_cleanliness(root)
        print(json.dumps(cleanliness.to_dict(), indent=2))
        sys.exit(0 if cleanliness.clean else 1)

    if args.rollback:
        result = rollback_workspace(root, target_sha=args.sha)
        print(json.dumps(result.to_dict(), indent=2))
        sys.exit(0 if result.success else 1)

    if args.reconcile:
        res = reconcile_workspace_drift(root)
        print(json.dumps(res.to_dict(), indent=2))
        sys.exit(0 if res.reconciled or res.summary == "Workspace and roadmap are in sync" else 1)

    parser.print_help()


if __name__ == "__main__":
    main()
