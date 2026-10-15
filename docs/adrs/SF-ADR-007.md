# SF-ADR-007 — Separate Execution and AgentRun Lifecycles; Event + Outbox Atomically Committed

- **Status:** Accepted
- **Date:** Phase 0 baseline
- **Source of record:** docs/43_BINDING_ADRS_AND_DECISION_POLICY.md (binding, v6.2)

## Context

LEGACY14-ADR-005 ("Execution Is Attempt") and the canonical lifecycle (doc 38) require that a bounded AgentRun proposal-generation loop is not confused with the durable Execution orchestration and approval/delivery lifecycle. `AgentRun.completed` means a proposal was generated, not that Execution is complete. Completion must never race ahead of approvals and verification.

## Decision

Keep the **Execution and AgentRun lifecycles separate**, and commit each lifecycle event **atomically with its outbox entry**.

**Invariant (normative):** no completion before approvals and verification.

## Consequences

- Execution may transition `queued → running → awaiting_approval → verifying → completed`, or to failure states; AgentRun tracks only the bounded generation loop.
- Each persisted transition shares one transaction with its outbox event; restart cannot lose the event stream.
- `awaiting_approval` releases the worker lease and checkpoints; resume revalidates approvals, policy, base SHA and budget.
- An Execution cannot reach `completed` until required approvals are granted and verification evidence passes.
- Distinct outcomes (execution, verification, acceptance, delivery) remain separately tracked (LEGACY14-ADR-027).