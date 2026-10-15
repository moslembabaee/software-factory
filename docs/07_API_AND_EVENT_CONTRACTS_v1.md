# API & Event Contracts v1

**Goal:** شروع implementation با contractهای کوچک و پایدار.

---

## 1. Work API

### Create Work

```http
POST /works
```

Example:

```json
{
  "intent": "Make application support online mode",
  "priority": "high",
  "source_ref": "conversation://123"
}
```

### Get Work

```http
GET /works/{id}
```

### Work Timeline

```http
GET /works/{id}/timeline
```

### Operational commands

```http
POST /works/{id}/commands
```

```json
{
  "command": "approve|pause|resume|retry|stop|reassign",
  "reason": "..."
}
```

---

## 2. Actor API

```http
GET /actors
GET /actors/{id}
```

MVP admin/config may be file-based.

---

## 3. Execution API

```http
GET /executions/{id}
POST /executions/{id}/cancel
```

Internal create happens through Dispatcher.

---

## 4. Flow API

```http
GET /flows
GET /flows/{id}
POST /flows/proposals
POST /flows/{id}/activate
```

---

## 5. Intake API

```http
POST /intake/messages
POST /intake/proposals/{id}/accept
```

Proposal accept creates Work(s).

---

## 6. Worker API

```http
POST /workers/register
POST /workers/{id}/heartbeat
POST /workers/{id}/executions
GET  /workers/{id}/executions/{execution_id}
POST /workers/{id}/executions/{execution_id}/cancel
```

---

## 7. Event envelope

```json
{
  "id": "evt_123",
  "event_type": "work.created",
  "source": "factory",
  "subject_type": "work",
  "subject_id": "W-104",
  "occurred_at": "2026-10-15T10:00:00Z",
  "recorded_at": "2026-10-15T10:00:00Z",
  "correlation_id": "corr_55",
  "causation_id": "evt_122",
  "payload": {}
}
```

---

## 8. Initial event names

Keep small:

```text
input.received
work.created
work.updated
work.blocked
work.approved
work.paused
work.resumed
work.completed
execution.created
execution.started
execution.progress
execution.stalled
execution.completed
execution.failed
execution.cancelled
execution.unknown
reference.produced
flow.started
flow.step.entered
flow.waiting
flow.completed
factory_change.proposed
factory_change.approved
factory_change.activated
worker.online
worker.offline
```

Add only when trace cannot be reconstructed without it.

---

## 9. Idempotency

External ingest should support:

```text
source + deduplication key
```

Worker execution start should support:

```text
execution_id as idempotency identity
```


---

## v3 protocol requirements

All mutation APIs accept `Idempotency-Key`, authenticated `principal`, `expected_version`, `correlation_id` and an auditable `reason` where relevant. Return `409` for version conflicts, `403` for scope denial, `202` for asynchronous accepted commands, and stable response on duplicate idempotency key. Retries with the same key but different payload are rejected.

Event envelope adds `schema_version` (integer), `aggregate_version`, `dedupe_key`, `producer_id`, `trace_id`; keep `occurred_at` distinct from `recorded_at`. Consumers must tolerate out-of-order and duplicate deliveries; partition ordering is guaranteed only per aggregate when explicitly configured. Version event schemas; use additive evolution or an upcaster.

Worker assignment includes `execution_id`, `attempt_no`, `lease_epoch`, opaque fencing token, `lease_until`, `sandbox_policy_id`, `credential_scope`, `deadline`, `artifact_upload_target`. Heartbeats include epoch and observed progress, not just liveness. Worker result includes receipt IDs and verified artifact digests. Stale epochs receive rejection and must terminate/quarantine.

Approval commands include `subject_digest` (exact diff/config hash), `scope`, `approver`, `expires_at`; an approval is invalid after digest changes. GitHub label/comments are untrusted *signals* until mapped to a verified provider identity and authorized role.

External effect protocol: `prepare(effect_key, digest) → authorize → execute → receipt → reconcile`. An effect whose outcome is unknown must not be blindly retried unless the provider supports idempotency and lookup. See `15_RELIABILITY_AND_RECOVERY_v1.md`.


## Integrated API compatibility (v6)

Existing Work/Execution endpoints remain supported. Agent runtime dispatch and callback contracts are internal versioned APIs (`/internal/v1/agent-runs`); external clients observe Execution and Event projections. All writes require idempotency keys and scoped authorization. See `33_API_EVENTS_AND_STORAGE_CONTRACTS.md`.
