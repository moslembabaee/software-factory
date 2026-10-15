# Software Factory — API, Events and Persistence Contracts

**Status:** normative, v1 contract for integrated build

## Public endpoints
- `POST /api/v1/works` create Work (idempotency key required)
- `GET /api/v1/works/{id}` Work + execution summary
- `POST /api/v1/works/{id}/executions` queue authorized Build run
- `GET /api/v1/executions/{id}` state, budget, artifact refs
- `GET /api/v1/executions/{id}/events?cursor=` ordered per-run events
- `POST /api/v1/executions/{id}/cancel` request cancellation
- `POST /api/v1/approvals/{id}/decisions` approve/deny with reviewer identity and reason
- `GET /api/v1/executions/{id}/artifacts` verified diff, logs, test reports

All write requests carry `Idempotency-Key`; all responses include `request_id`. Auth uses tenant/project-scoped RBAC and resource ownership checks. Never trust client-supplied actor or tenant IDs. Pagination cursors are opaque.

## Internal worker contracts
- `POST /internal/v1/agent-runs/claim`: atomically lease queued Execution (worker identity and fencing token).
- `POST /internal/v1/agent-runs/{id}/heartbeat`: extend lease if fencing token matches.
- `POST /internal/v1/agent-runs/{id}/events`: append batch with `(execution_id, sequence)` unique key.
- `POST /internal/v1/agent-runs/{id}/complete`: compare-and-swap terminal state; attach verified artifacts.
- `POST /internal/v1/agent-runs/{id}/checkpoint`: save resumable checkpoint pointer.

Use mTLS/service identity and short-lived scoped tokens between workers and Core.

## Event envelope
```json
{
 "event_id":"uuid", "schema_version":1, "tenant_id":"uuid",
 "work_id":"uuid", "execution_id":"uuid", "sequence":17,
 "type":"agent.tool.completed", "occurred_at":"2026-10-15T10:00:00Z",
 "actor_id":"uuid", "correlation_id":"uuid", "causation_id":"uuid",
 "payload":{"tool":"test.run","status":"success","artifact_ref":"sha256:..."}
}
```

Events include `execution.queued`, `execution.started`, `agent.step.started`, `agent.tool.requested`, `agent.tool.completed`, `approval.requested`, `approval.decided`, `agent.checkpoint.created`, `execution.completed`, `execution.failed`, `execution.cancelled`, `budget.exhausted`. Events are append-only; corrections are new events. Consumer delivery is at least once; projections deduplicate by event ID.

## Storage (PostgreSQL baseline)
Existing six primitive tables remain authoritative. Additional projections/tables: `agent_runs(id, execution_id UNIQUE, model_profile, status, step_count, context_checkpoint_ref, created_at, updated_at)`, `tool_invocations(id, execution_id, step_no, tool_name, status, approval_id NULL, result_ref)`, `approval_requests(id, execution_id, action_hash, policy_version, state, reviewer_id, expires_at)`, `budget_ledger(id, execution_id, kind, amount, currency, provider_request_id UNIQUE)`, `worker_leases(execution_id PRIMARY KEY, worker_id, fencing_token, expires_at)`.

Indexes: events `(execution_id, sequence)` unique; works `(tenant_id, state)`; executions `(work_id, created_at)`; approval requests `(tenant_id, state)` through joined/denormalized tenant key. Large blobs and logs in encrypted object storage, with retention and deletion policy.

## Error response
```json
{"error":{"code":"APPROVAL_REQUIRED","message":"Approval required","request_id":"uuid","retryable":false}}
```

Use `409` for state conflict, `422` for schema validation, `403` for policy denial, `429` for quotas, `503` for transient backend outage.

## Compatibility
Version event payloads and API contracts; additive changes allowed within v1. Breaking changes require `/v2` or a new event schema version and migration.

## v6.1 binding clarification
This is an endpoint inventory and persistence baseline, not an exhaustive schema. The implementation must generate and test the full OpenAPI, JSON Schemas and migrations required by 41.
