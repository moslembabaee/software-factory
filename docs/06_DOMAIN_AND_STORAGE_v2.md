# Domain & Storage v2

**Status:** Minimal persistence model

---

## 1. Core entities

### Work

```text
id
intent
state              # open | active | terminal
priority?
created_at
updated_at
metadata_json
```

Priority operational metadata است، نه identity.

Useful metadata:

- source
- blocked reason
- approval summary
- flow context ref

### Actor

```text
id
kind?
adapter_key
endpoint_ref?
tags[]?
metadata_json
created_at
```

### Execution

```text
id
work_id
actor_id
worker_id?
state
attempt_no
started_at?
ended_at?
last_progress_at?
external_run_ref?
sandbox_ref?
metadata_json
```

### Reference

```text
id
uri
kind?
metadata_json
```

### Relation

```text
id
from_type
from_id
relation_type
to_type
to_id
created_at
metadata_json
```

Useful conventions:

- triggered-by
- created-from
- depends-on
- blocked-by
- performed-by
- produced
- verified-by
- retry-of
- derived-from

Taxonomy hard-coded Core نیست.

### Event

```text
id
source
event_type
subject_type?
subject_id?
occurred_at
recorded_at
correlation_id?
causation_id?
payload_json
```

---

## 2. Runtime tables

این‌ها Core entities نیستند ولی implementation لازمشان دارد.

### flow_definitions

```text
id
version
status
content
created_at
activated_at?
```

### flow_runs

```text
id
flow_id
flow_version
state
current_step
context_json
started_at
ended_at?
```

### workers

```text
id
state
capacity
runtimes_json
last_heartbeat_at
metadata_json
```

### factory_change_proposals

```text
id
kind
requested_by
diff_ref
state
reason
created_at
approved_at?
activated_at?
```

---

## 3. Projection/views

- work_queue
- work_timeline
- runnable_work
- blocked_work
- actor_recent_performance
- worker_capacity
- execution_current_state
- work_trace_summary

All rebuildable where practical.

---

## 4. State guidance

Work:

```text
open → active → terminal
```

Operational labels/status can be richer in projection/UI:

```text
queued
waiting_approval
blocked
running
paused
completed
cancelled
```

Do not force all of them into Core state machine.

Execution:

```text
created → running → terminal | unknown
```

---

## 5. Data ownership

External objects remain external.

Factory stores:

- Reference
- minimal display metadata
- coordination state
- lineage


---

## v3 schema additions and consistency

Six Core primitives remain conceptual; runtime tables are not artificially limited. Add migrations for:

- `work_versions(work_id, version, ...)` or `works.version` for compare-and-swap transitions.
- `execution_leases(execution_id, work_id, lease_epoch, token_hash, expires_at, revoked_at, worker_id)`; enforce one valid owner using transactional claim logic.
- `outbox(id, aggregate_id, aggregate_version, event_id, payload, published_at, attempts)` and `inbox(source, external_event_id, processed_at, result_ref)` with unique constraints.
- `flow_step_runs`, `flow_waits`, `flow_child_runs` for durable orchestration.
- `approvals(id, subject_type, subject_id, subject_digest, scope_json, approver_id, decision, expires_at, revoked_at, created_at)`.
- `external_effects(id, execution_id, effect_key, provider, operation, request_digest, status, receipt_ref, reconciled_at)` with unique `(provider, effect_key)`.
- `verification_results` and `acceptance_results`, separate from execution outcome.
- `audit_log` append-only with actor identity, source, decision reason, previous/new state and correlation ID.

**Authoritative state:** transactional relational state is authoritative for current lifecycle. The append-only Event log is the audit/integration record; it is **not** declared a fully replayable event-sourced system. Rebuild read projections from snapshots plus committed events where supported, not by assuming all business state is reconstructable.

**Work invariants:** terminal outcomes `completed`, `cancelled`, `failed` are distinct; `completed` requires accepted verification and acceptance evidence. `blocked`, `waiting_approval`, `paused` are explicit operational substates with validated transitions, not freely editable labels. Commands carry `expected_version` and return conflict on stale writes.

**Retention:** define log/artifact retention by environment; default sensitive prompts/outputs are redacted, access controlled and never copied wholesale to third-party integrations. Nightly backup and periodic restore drill required before real project use.


## Integrated agent persistence (v6)

Do not add agent-specific primitives to the six-element domain core. Persist `agent_run`, `agent_checkpoint`, `tool_invocation`, `approval_request` and `budget_ledger` as implementation projections keyed by `execution_id`; store large prompts/logs/artifacts in object storage, referenced by opaque IDs. See `33_API_EVENTS_AND_STORAGE_CONTRACTS.md`.
