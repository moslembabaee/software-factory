# GitHub issue and roadmap synchronization

Apply `factory/task` to an open issue to create or link a task in `ROADMAP.json`.
The webhook listener and `issue_bot.py` polling use the same reconciliation code
in `issue_sync.py`. Existing task IDs in a `factory-task-id` HTML marker or
`Task ID:` field are reused when they do not belong to another issue. Otherwise,
intake creates `T-ISSUE-<number>`. GitHub receives a comment containing the task ID,
and the task stores `github_issue_number`.

Phase mappings come from `maintainers.json`:

```json
{
  "label_config": {
    "phases": {
      "phase/backend": "Phase 1: Core APIs + RLS",
      "phase/interface": "Phase 4: Ask/Build UI"
    },
    "default_phase": "Community & Issues"
  }
}
```

Custom mappings take precedence over built-in phase labels. Multiple matching
labels are evaluated in alphabetical order within each precedence level.
The primary GitHub assignee is stored as `assignee`; recognized agent names
(`claude`, `codex`, `antigravity`, case insensitive) also select `assigned_agent`.
New tasks otherwise use the default execution agent, `claude`.

Issue title/body edits, phase label changes and assignment changes update the
linked task. Parent edits preserve decomposed subtasks' individual scopes.
Removing `factory/task` unlinks its managed tasks and pauses unfinished work,
clearing the active task pointer. Applying the label again restores the same
links and resumes tasks paused by unlinking. Ordinary legacy issue tasks do not
opt into this label policy until they receive `factory/task`.

For tasks managed by this sync, `verified`, `done`, and `completed` trigger a
result comment with available commit, PR and successful verification references.
The issue closes after every linked task is ready. Existing legacy PR tasks
retain their merge-before-closure policy unless `close_on_verified` is explicitly
enabled. `/task/transition` notifications must match a status already persisted
in the roadmap; the endpoint does not advance task lifecycle state.

Reconciliation and webhook receipts share the roadmap file lock and atomic
replacement. Receipts retain the last 5,000 events, identified by issue ID and
source timestamp, plus event/action/label/comment identity to distinguish events
within the same second. Older issue snapshots cannot overwrite a newer one.
Each action records its GitHub source in roadmap and task history.

GitHub comment delivery checks all comment pages for a stable marker before
writing, so replay after a crash does not post another comment. Failed writes
remain pending; webhook intake returns HTTP 503 and polling retries pending
work. Comment and closure acknowledgments are saved only after successful writes.
Polling recovers missed issue webhooks and task completion notifications.
