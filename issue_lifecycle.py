"""Shared issue routing, label inference, link reconciliation, and close-state rules."""

from __future__ import annotations

import json
import re
from datetime import datetime, timezone
from pathlib import Path

FACTORY_TASK_LABEL = "factory/task"

IGNORED_LABELS = frozenset({
    "infra", "infrastructure", "ops", "devops", "operations",
    "documentation", "docs", "manual", "wontfix", "invalid",
})

DEFAULT_LABEL_PHASE_MAP: dict[str, str] = {
    "phase/1": "Phase 1: Core APIs + RLS",
    "phase/core-apis": "Phase 1: Core APIs + RLS",
    "phase:1": "Phase 1: Core APIs + RLS",
    "phase:core-apis": "Phase 1: Core APIs + RLS",
    "phase 1": "Phase 1: Core APIs + RLS",
    "phase 1: core apis + rls": "Phase 1: Core APIs + RLS",
    "core apis + rls": "Phase 1: Core APIs + RLS",
    "phase/2": "Phase 2: Queue + Sandbox",
    "phase/queue-sandbox": "Phase 2: Queue + Sandbox",
    "phase:2": "Phase 2: Queue + Sandbox",
    "phase:queue-sandbox": "Phase 2: Queue + Sandbox",
    "phase 2": "Phase 2: Queue + Sandbox",
    "phase 2: queue + sandbox": "Phase 2: Queue + Sandbox",
    "queue + sandbox": "Phase 2: Queue + Sandbox",
    "phase/3": "Phase 3: Agent Runtime",
    "phase/agent-runtime": "Phase 3: Agent Runtime",
    "phase:3": "Phase 3: Agent Runtime",
    "phase:agent-runtime": "Phase 3: Agent Runtime",
    "phase 3": "Phase 3: Agent Runtime",
    "phase 3: agent runtime": "Phase 3: Agent Runtime",
    "agent runtime": "Phase 3: Agent Runtime",
    "phase/4": "Phase 4: Ask/Build UI",
    "phase/ask-build-ui": "Phase 4: Ask/Build UI",
    "phase:4": "Phase 4: Ask/Build UI",
    "phase:ask-build-ui": "Phase 4: Ask/Build UI",
    "phase 4": "Phase 4: Ask/Build UI",
    "phase 4: ask/build ui": "Phase 4: Ask/Build UI",
    "ask/build ui": "Phase 4: Ask/Build UI",
    "phase/polish": "Continuous Polish & Evolution",
    "phase/evolution": "Continuous Polish & Evolution",
    "phase:polish": "Continuous Polish & Evolution",
    "phase:evolution": "Continuous Polish & Evolution",
    "polish": "Continuous Polish & Evolution",
    "evolution": "Continuous Polish & Evolution",
    "continuous polish": "Continuous Polish & Evolution",
    "continuous polish & evolution": "Continuous Polish & Evolution",
    "phase/community": "Community & Issues",
    "phase:community": "Community & Issues",
    "community": "Community & Issues",
    "community & issues": "Community & Issues",
}

KNOWN_PHASES = (
    "Phase 1: Core APIs + RLS",
    "Phase 2: Queue + Sandbox",
    "Phase 3: Agent Runtime",
    "Phase 4: Ask/Build UI",
    "Continuous Polish & Evolution",
    "Community & Issues",
)


def label_names(issue: dict) -> set[str]:
    return {str(label.get("name", "")).strip().lower() for label in issue.get("labels", []) if isinstance(label, dict)}


def issue_number_for_task(task: dict) -> int | None:
    if task.get("unlinked"):
        return None
    if task.get("github_issue_number"):
        try:
            return int(task["github_issue_number"])
        except (ValueError, TypeError):
            pass
    task_id = task.get("id", "")
    if task_id.startswith("T-ISSUE-"):
        number = task_id[len("T-ISSUE-"):].split("-", 1)[0]
        if number.isdigit():
            return int(number)
    # Check description for "Reference: Closes #14" or "Closes #14" or "Issue #14"
    desc = task.get("description") or ""
    m = re.search(r'(?:Closes|Fixes|Resolves|Parent Issue:?|Issue:?)\s*#(\d+)', desc, re.IGNORECASE)
    if m:
        try:
            return int(m.group(1))
        except (ValueError, TypeError):
            pass
    # Check title for "Issue #14"
    title = task.get("title") or ""
    m = re.search(r'Issue\s*#(\d+)', title, re.IGNORECASE)
    if m:
        try:
            return int(m.group(1))
        except (ValueError, TypeError):
            pass
    return None


def extract_task_id_from_text(text: str) -> str | None:
    if not text:
        return None
    # Check for HTML comment marker <!-- factory-task-id: (task_id) -->
    m = re.search(r'<!--\s*factory-task-id:\s*([A-Za-z0-9_-]+)\s*-->', text, re.IGNORECASE)
    if m:
        return m.group(1).strip()
    # Check for **Task ID:** `(task_id)` or Task ID: (task_id)
    m = re.search(r'(?:\*\*Task ID:\*\*|Task ID:)\s*`?([A-Za-z0-9_-]+)`?', text, re.IGNORECASE)
    if m:
        return m.group(1).strip()
    # Check for T-ISSUE-X pattern
    m = re.search(r'\b(T-ISSUE-\d+(?:-\d+)?)\b', text)
    if m:
        return m.group(1).strip()
    return None


def extract_task_id_from_issue(issue: dict) -> str | None:
    body = issue.get("body") or ""
    tid = extract_task_id_from_text(body)
    if tid:
        return tid
    comments = issue.get("comments") or []
    if isinstance(comments, list):
        for c in comments:
            if isinstance(c, dict):
                c_body = c.get("body") or ""
                tid = extract_task_id_from_text(c_body)
                if tid:
                    return tid
            elif isinstance(c, str):
                tid = extract_task_id_from_text(c)
                if tid:
                    return tid
    return None


def task_matches_issue(task: dict, number: int, issue_task_id: str | None = None, include_unlinked: bool = False) -> bool:
    if not include_unlinked and task.get("unlinked"):
        return False
    if task.get("github_issue_number") and task.get("github_issue_number") != number:
        return False
    if issue_task_id and task.get("id") == issue_task_id:
        return True
    if include_unlinked and task.get("unlinked_from_issue") == number:
        return True
    if task.get("github_issue_number") == number:
        return True
    if include_unlinked:
        task_id = task.get("id", "")
        if task_id.startswith("T-ISSUE-"):
            num_part = task_id[len("T-ISSUE-"):].split("-", 1)[0]
            if num_part.isdigit() and int(num_part) == number:
                return True
        desc = task.get("description") or ""
        m = re.search(r'(?:Closes|Fixes|Resolves|Parent Issue:?|Issue:?)\s*#(\d+)', desc, re.IGNORECASE)
        if m:
            try:
                if int(m.group(1)) == number:
                    return True
            except (ValueError, TypeError):
                pass
        title = task.get("title") or ""
        m = re.search(r'Issue\s*#(\d+)', title, re.IGNORECASE)
        if m:
            try:
                if int(m.group(1)) == number:
                    return True
            except (ValueError, TypeError):
                pass
    return issue_number_for_task(task) == number


def mark_issue_in_progress(roadmap: dict, task: dict,
                           working_branch: str | None = None) -> bool:
    """Apply transparent active-execution state to a claimed task.

    Adds a GitHub 'in-progress' label and (when a Rabbit message target is
    available) records the commit/branch under which the agent is running.
    This is a supervisor/side-effect call; it never touches application code.
    """
    number = issue_number_for_task(task)
    if not number:
        return False
    modified = False
    for candidate in roadmap.get("tasks", []):
        if not task_matches_issue(candidate, number):
            continue
        candidate["status"] = "in_progress"
        if working_branch:
            candidate["active_branch"] = working_branch
        modified = True
    return modified


def infer_phase_from_labels(labels: set[str] | list[str] | list[dict] | dict, label_config: dict | None = None) -> str:
    """Infer the roadmap phase from label configuration or defaults."""
    if isinstance(labels, dict):
        raw_labels = label_names(labels)
    elif isinstance(labels, (set, list, tuple)):
        raw_labels = set()
        for l in labels:
            if isinstance(l, dict):
                name = l.get("name", "")
                if name:
                    raw_labels.add(str(name).strip().lower())
            elif isinstance(l, str):
                raw_labels.add(l.strip().lower())
    else:
        raw_labels = set()

    # Load custom mapping if provided
    custom_map: dict[str, str] = {}
    default_phase: str | None = None
    if label_config:
        phases = label_config.get("phases") or label_config.get("label_phase_map") or label_config
        if isinstance(phases, dict):
            for k, v in phases.items():
                if isinstance(k, str) and isinstance(v, str):
                    custom_map[k.strip().lower()] = v.strip()
        default_phase = label_config.get("default_phase")

    # 1. Check custom config map first
    for label in sorted(raw_labels):
        if label in custom_map:
            return custom_map[label]

    # 2. Check DEFAULT_LABEL_PHASE_MAP
    for label in sorted(raw_labels):
        if label in DEFAULT_LABEL_PHASE_MAP:
            return DEFAULT_LABEL_PHASE_MAP[label]

    # 3. Check for prefixes like phase/ or phase:
    for label in sorted(raw_labels):
        for prefix in ("phase/", "phase:", "factory/phase/", "factory/phase:"):
            if label.startswith(prefix):
                suffix = label[len(prefix):].strip()
                if suffix in custom_map:
                    return custom_map[suffix]
                if suffix in DEFAULT_LABEL_PHASE_MAP:
                    return DEFAULT_LABEL_PHASE_MAP[suffix]
                # Try matching by number
                if suffix == "1" or suffix.startswith("1"):
                    return "Phase 1: Core APIs + RLS"
                if suffix == "2" or suffix.startswith("2"):
                    return "Phase 2: Queue + Sandbox"
                if suffix == "3" or suffix.startswith("3"):
                    return "Phase 3: Agent Runtime"
                if suffix == "4" or suffix.startswith("4"):
                    return "Phase 4: Ask/Build UI"
                for known in KNOWN_PHASES:
                    if suffix in known.lower():
                        return known

    # 4. Check if any known phase name is present in labels
    for label in sorted(raw_labels):
        for known in KNOWN_PHASES:
            if known.lower() == label or known.lower() in label:
                return known

    # Default fallback
    return default_phase or "Community & Issues"


def extract_assignee(issue: dict) -> str | None:
    """Extract the primary assignee login from a GitHub issue payload."""
    assignee = issue.get("assignee")
    if isinstance(assignee, dict) and assignee.get("login"):
        return str(assignee["login"]).strip()
    if isinstance(assignee, str) and assignee.strip():
        return assignee.strip()

    assignees = issue.get("assignees")
    if isinstance(assignees, list) and assignees:
        first = assignees[0]
        if isinstance(first, dict) and first.get("login"):
            return str(first["login"]).strip()
        if isinstance(first, str) and first.strip():
            return first.strip()
    return None


def get_webhook_dedupe_key(payload: dict, headers: dict | None = None) -> str | None:
    """Issue identity and source timestamp, scoped to the event that changed it.

    GitHub timestamps have second precision; distinct labels and comments may
    share an issue timestamp. Delivery IDs change on some replay paths.
    """
    headers = headers or {}
    issue = payload.get("issue") or {}
    identity = issue.get("id") or issue.get("number")
    if identity is None:
        return None
    comment = payload.get("comment") or {}
    event_time = (comment.get("updated_at") or comment.get("created_at") or
                  issue.get("updated_at") or issue.get("updatedAt") or
                  payload.get("event_timestamp") or payload.get("timestamp"))
    if not event_time:
        event_time = headers.get("X-GitHub-Delivery") or headers.get("x-github-delivery")
    if not event_time:
        return None
    return json.dumps([str(identity), event_time,
                       headers.get("X-GitHub-Event") or headers.get("x-github-event") or "issues",
                       payload.get("action", ""), (payload.get("label") or {}).get("name", ""),
                       comment.get("id")], separators=(",", ":"))


def is_webhook_duplicate(key: str, dedupe_file: Path | str | None = None, memory_set: set[str] | None = None) -> bool:
    if memory_set is not None and key in memory_set:
        return True
    if dedupe_file is not None:
        p = Path(dedupe_file)
        if p.exists():
            try:
                data = json.loads(p.read_text(encoding="utf-8"))
                if isinstance(data, list) and key in data:
                    if memory_set is not None:
                        memory_set.add(key)
                    return True
                if isinstance(data, dict) and key in data:
                    if memory_set is not None:
                        memory_set.add(key)
                    return True
            except Exception:
                pass
    return False


def record_webhook_processed(key: str, dedupe_file: Path | str | None = None, memory_set: set[str] | None = None) -> None:
    if memory_set is not None:
        memory_set.add(key)
    if dedupe_file is not None:
        p = Path(dedupe_file)
        try:
            p.parent.mkdir(parents=True, exist_ok=True)
            existing: list[str] = []
            if p.exists():
                try:
                    data = json.loads(p.read_text(encoding="utf-8"))
                    if isinstance(data, list):
                        existing = data
                except Exception:
                    existing = []
            if key not in existing:
                existing.append(key)
                if len(existing) > 5000:
                    existing = existing[-5000:]
                temp_p = p.with_suffix(".tmp")
                temp_p.write_text(json.dumps(existing, indent=2), encoding="utf-8")
                temp_p.replace(p)
        except Exception:
            pass


def build_link_comment(task_id: str, phase: str = "", assignee: str | None = None) -> str:
    assignee_str = f"@{assignee}" if assignee else "unassigned"
    return (
        f"🚀 **Roadmap Task Linked!**\n\n"
        f"- **Task ID:** `{task_id}`\n"
        f"- **Phase:** {phase}\n"
        f"- **Assignee:** {assignee_str}\n\n"
        f"<!-- factory-task-id: {task_id} -->\n"
        f"Linked to roadmap task: `{task_id}`"
    )


def build_result_comment(task: dict, status: str) -> str:
    task_id = task.get("id", "unknown")
    title = task.get("title", "")
    phase = task.get("phase", "")
    commit_sha = (
        task.get("commit_sha")
        or task.get("merge_commit_sha")
        or task.get("commit")
        or task.get("sha")
    )
    pr_ref = (
        task.get("pr_number")
        or task.get("pr_url")
        or task.get("pr_reference")
        or task.get("pr")
    )

    status_display = "Verified" if status == "verified" else "Completed"
    lines = [
        f"✅ **Task Implementation {status_display}!**\n",
        f"- **Task ID:** `{task_id}`",
        f"- **Title:** {title}",
        f"- **Phase:** {phase}",
        f"- **Status:** `{status}`",
    ]
    if commit_sha:
        lines.append(f"- **Commit:** `{commit_sha}`")
    if pr_ref:
        pr_str = f"#{pr_ref}" if isinstance(pr_ref, int) or str(pr_ref).isdigit() else str(pr_ref)
        lines.append(f"- **Pull Request:** {pr_str}")

    verifications = task.get("verifications")
    if isinstance(verifications, list) and verifications:
        last_v = verifications[-1]
        if isinstance(last_v, dict) and last_v.get("exit_code") == 0:
            lines.append(f"- **Verification:** Passed (`{last_v.get('command', 'verification_cmd')}`)")

    lines.append("\nClosing linked GitHub issue.")
    return "\n".join(lines)


def unlink_and_pause_task(task: dict, issue_num: int, reason: str = "") -> bool:
    """Unlink the task from GitHub issue and pause it if not already finished."""
    task["github_issue_number"] = None
    task["unlinked"] = True
    task["unlinked_from_issue"] = issue_num
    if task.get("status") not in ("done", "completed", "verified", "closed"):
        task["status"] = "paused"
        task["paused_at"] = datetime.now(timezone.utc).isoformat()
        task["pause_reason"] = reason or f"Unlinked from GitHub issue #{issue_num}"
        return True
    return False


def record_sync_history(roadmap_data: dict, task: dict | None, record: dict) -> None:
    """Record GitHub sync event in the roadmap history and task history."""
    roadmap_data.setdefault("sync_history", []).append(record)
    roadmap_data.setdefault("history", []).append(record)
    if task is not None:
        task.setdefault("history", []).append(record)
        task.setdefault("sync_history", []).append(record)


def mark_issue_closed(roadmap: dict, number: int, closed_at: str | None = None, issue_id: str | None = None) -> bool:
    """Closure is terminal for every linked task, including decomposed tasks."""
    modified = False
    timestamp = closed_at or datetime.now(timezone.utc).isoformat()
    for task in roadmap.get("tasks", []):
        if not task_matches_issue(task, number):
            continue
        if task.get("status") != "completed" or not task.get("closed_at"):
            task["status"] = "completed"
            if not task.get("completed_at"):
                task["completed_at"] = timestamp
            if not task.get("closed_at"):
                task["closed_at"] = timestamp
            record = {
                "timestamp": timestamp,
                "github_event": "issues",
                "github_action": "closed",
                "issue_id": issue_id,
                "issue_number": number,
                "task_id": task.get("id"),
                "action": "task_completed_from_closed_issue",
                "message": f"GitHub issue #{number} closed: marked task {task.get('id')} completed",
            }
            record_sync_history(roadmap, task, record)
            modified = True
        if roadmap.get("current_task_id") == task.get("id"):
            roadmap["current_task_id"] = None
            modified = True
    return modified