# Reliability, Concurrency & Recovery v1 — Normative

## Consistency model
PostgreSQL transaction commits aggregate state, monotonically incremented version, audit Event and outbox record together. External effects are executed only after commit. Outbox publisher retries at least once; consumers use durable inbox deduplication. No exactly-once delivery claim.

## State ownership
Transition Coordinator is the sole writer for lifecycle transitions. Every command has principal, idempotency key, expected aggregate version and correlation ID. Rule/Flow/Supervisor/Dispatcher may propose but cannot directly commit transitions.

## Execution claim algorithm
1. In a transaction, lock eligible Work (`FOR UPDATE SKIP LOCKED` or equivalent), verify dependencies, approval and budget.
2. Ensure no current claim/active effect owner, increment `lease_epoch`, create new Execution attempt and lease, emit event/outbox, commit.
3. Worker obtains scoped sandbox credentials for epoch, heartbeats before `lease_until`, and publishes outputs through gateway.
4. Gateway checks epoch, Work state, permission, base SHA and approval digest before external writes.
5. On expiry, mark `unknown` and revoke gateway access; reconcile external receipts and sandbox state before starting replacement attempt.

A lease/fencing token only protects gateways that enforce it. A provider called directly by an untrusted worker cannot be fenced: prohibit direct provider write access.

## Recovery state matrix
| Failure | State | Action |
|---|---|---|
| Worker heartbeat missing | unknown | revoke gateway; query worker and effects; no immediate unsafe retry |
| Duplicate webhook | unchanged | inbox unique key, return previous result |
| DB commit succeeds but publish fails | committed | outbox republishes |
| External API timed out | needs_reconciliation | provider lookup by idempotency key; escalate if unsupported |
| Crash after child flow creation | running | reattach child using stable key |
| Cancel requested | cancelling | revoke effects; terminate sandbox; mark cancelled after confirmation or unknown |
| Merge base changed | blocked | rebase, retest, seek approval again if diff changes |

## Budgets and fairness
Per Work limits: max attempts 3, max execution wall time 60 min, max cumulative execution 120 min, token/cost cap configurable and mandatory before dispatch. Backoff starts at 30 seconds, exponential with jitter and 10-minute cap. Never retry non-idempotent unknown effects automatically. Capacity reservation and queue fairness must prevent one Work monopolizing workers.

## Acceptance
Execution success = process outcome. Verification = checks and artifact provenance. Acceptance = Work-specific criteria plus human approval where configured. Delivery = merge/deploy/handoff receipt. Completion only after required acceptance; delivery tracked separately and may be pending.

## Required crash-injection tests
Crash before/after transaction commit, outbox publish, child-run creation, external API timeout, lease expiration with old worker alive, cancellation race, duplicate provider webhook, and stale merge attempt. Every case must preserve invariant: no unauthorized/stale externally visible effect and no silently lost state transition.
