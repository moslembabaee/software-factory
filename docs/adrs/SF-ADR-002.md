# SF-ADR-002 — PostgreSQL Transactional State, Outbox, Durable Jobs and Leases

- **Status:** Accepted
- **Date:** Phase 0 baseline
- **Source of record:** docs/43_BINDING_ADRS_AND_DECISION_POLICY.md (binding, v6.2)

## Context

Relational lifecycle state is authoritative (LEGACY14-ADR-021/LEGACY36 lineage: transactional state + outbox, single transition authority, lease/fencing). Execution transitions must be persisted atomically with their outbox events, and job queues plus worker leases must survive process restarts. Any in-memory source of truth would lose transitions, duplicate protected effects and break fencing guarantees.

## Decision

Use **PostgreSQL** as the single transactional store for state, the **outbox**, **durable jobs** and **leases**.

**Invariant (normative):** Serializable or explicit CAS for contested transitions; no in-memory source of truth.

## Consequences

- Contested lifecycle transitions are committed under Serializable isolation or explicit compare-and-set on expected version; illegal transitions are rejected.
- Committed events and outbox entries share the same transaction as the state change (at-least-once delivery with dedup).
- Job claims and worker leases are durable; stale workers cannot publish through authorized paths (fencing).
- No component may treat in-memory data as authoritative — a restart must never lose committed state.
- PostgreSQL is a deploy-time requirement; missing credentials are a deploy-time blocker, not permission to omit the store.