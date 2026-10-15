# Distributed Workers & Sandbox v1

**Goal:** چند Actor/Agent بتوانند هم‌زمان روی Workerهای مختلف و workspaceهای ایزوله اجرا شوند.

---

## 1. Key distinction

```text
Actor   = who/what does the Work
Worker  = where Execution runs
Sandbox = isolated workspace/environment for that Execution
```

این سه نباید یکی شوند.

---

## 2. Worker registration

Worker حداقل اعلام می‌کند:

```yaml
worker:
  id: worker-01
  runtimes:
    - codex
    - claude
  capacity: 4
  sandbox:
    type: docker
```

Current observations:

- online/offline
- free slots
- active executions
- disk/resources if relevant

---

## 3. Execution scheduling

```text
Work
→ Actor selected
→ runtime requirement known
→ compatible Worker selected
→ Sandbox created
→ repo/context prepared
→ Actor invoked
```

---

## 4. Sandbox baseline

هر Execution یا Work باید workspace ایزوله داشته باشد.

MVP choices:

- git worktree
- Docker container
- temporary directory

Recommended progression:

```text
Phase 1: git worktree + process isolation
Phase 2: Docker
Phase 3: remote ephemeral workers
```

---

## 5. Repository isolation

برای executionهای موازی:

- branch/worktree جدا
- no shared mutable working tree
- explicit merge/rebase strategy
- conflict becomes observable Event/Work

---

## 6. Credentials

Worker فقط credential لازم برای Execution را بگیرد.

No global secret dump.

---

## 7. Worker API

حداقل contract:

```text
register()
heartbeat()
prepare_execution()
start_execution()
observe_execution()
cancel_execution()
cleanup_execution()
```

---

## 8. Failure cases

### Worker dies

Execution → unknown  
Control Plane reconcile می‌کند.

### Network disconnect

timeout ≠ failed automatically.

### Sandbox lost

Execution may fail/unknown; retry creates new Execution.

### Duplicate delivery

execution start باید idempotent یا deduplicated باشد.

---

## 9. Non-goals

- Kubernetes clone
- autoscaling platform
- cluster scheduler عمومی
- container orchestration framework


---

## v3 isolation and concurrency policy

Git worktree provides **filesystem workflow separation, not a security boundary**. For any agent with shell access, run a container/VM sandbox with non-root user, resource quotas, restricted mounts, read-only base filesystem where practical, and default-deny network egress with explicit allowlist. Protect host sockets, SSH agents, metadata services, credential files and `.factory/**` through enforcement outside the agent.

Each execution receives short-lived, least-privilege credentials through a broker; never inject global host credentials or reusable tokens into a writable workspace. Revoke on completion/cancel. Store secrets encrypted and redact logs.

Use per-Work branch ownership and unique execution worktrees. Changes enter a staging branch or PR only through an Effect Gateway checking current fencing token, approved scope and base SHA. Serialize merges per target branch; rebase/retest on base changes; conflicts create blocked Work rather than silent overwrites.

A worker losing connection may continue running. Do not assume lease expiry killed it: isolate its external privileges, quarantine its artifacts, and reconcile side effects before retry. Record sandbox termination confirmation and cleanup status. See `16_SECURITY_AND_APPROVAL_v1.md`.


## Integrated coding-worker profile (v6)

Workers run the coding agent in an ephemeral per-Execution sandbox, with immutable base image, isolated workspace, network egress policy, secrets broker and resource quotas. Worktree is pinned to a commit SHA. Tools run only through a policy-enforcing gateway; shell, patch, search, test, git and optional MCP are mediated. See `34_SECURITY_SANDBOX_AND_APPROVALS.md`.
