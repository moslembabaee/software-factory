# SF-ADR-009 — Durable Intent Log and Reconcile-Before-Retry for Remote Side Effects

- **Status:** Accepted
- **Date:** Phase 0 baseline
- **Source of record:** docs/43_BINDING_ADRS_AND_DECISION_POLICY.md (binding, v6.2)

## Context

Remote side effects (Git pushes, merges, deploys, provider calls) can time out after submission with an unknown outcome. Blind retry risks duplicate protected effects; the factory makes no exactly-once promise for external effects (LEGACY14-ADR-030) and relies on provider idempotency/receipts or manual reconciliation. Every external effect must record intent, action digest, idempotency key, effect ID, fencing token and observed outcome (doc 38).

## Decision

Maintain a **durable intent log** for every remote side effect and **reconcile with the remote provider before any retry**.

**Invariant (normative):** unknown outcome never blindly retried.

## Consequences

- Timeout after submission yields `unknown` and `needs_reconciliation` states, not immediate retry.
- Recovery reconciles by stable identifier (effect ID / idempotency key) before deciding whether a retry is safe.
- If no reliable read-after-write verification exists, execution is suspended for human adjudication rather than retried.
- Duplicate event delivery is acceptable; duplicate protected effects are not.
- The intent log gives audit traceability for every external effect regardless of final outcome.