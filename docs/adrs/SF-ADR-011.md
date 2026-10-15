# SF-ADR-011 — Self-Modification Requires Independent Reviewer and Rollback Proof

- **Status:** Accepted
- **Date:** Phase 0 baseline
- **Source of record:** docs/43_BINDING_ADRS_AND_DECISION_POLICY.md (binding, v6.2)

## Context

LEGACY14-ADR-012 gives self-modification higher authority: factory behavior change follows proposal → diff → approval → activation, and LEGACY14-ADR-013 removes emergency stop from agent authority. A self-modifying system must not be able to loosen its own constraints — especially its own approval policy — or it can ratchet itself into an unsafe state with no way back.

## Decision

Self-modification requires an **independent reviewer** and **rollback proof**.

**Invariant (normative):** cannot alter own approval policy.

## Consequences

- Policy elevation and self-modification require an independent reviewer; the system (or any agent) cannot approve its own policy changes.
- A change is activated only with demonstrated rollback capability, so a bad activation is reversible.
- The approval policy itself is out of reach of self-modification — attempts are rejected regardless of approval.
- Emergency stop remains outside agent authority (LEGACY14-ADR-013): agents cannot re-enable it.
- All self-modification flows still follow proposal → diff → approval → activation with digest-bound approvals (SF-ADR-008).