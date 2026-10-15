# SF-ADR-008 — Scoped One-Use Approval Bound to Canonical Action Digest

- **Status:** Accepted
- **Date:** Phase 0 baseline
- **Source of record:** docs/43_BINDING_ADRS_AND_DECISION_POLICY.md (binding, v6.2)

## Context

Approvals must be digest-bound and immutable (LEGACY14-ADR-026, doc 38): an approval cannot be reused for a different action, a different version of the same action, or after it has already been consumed. Without binding to a canonical digest, an approval could be replayed against mutated content.

## Decision

Approvals are **scoped, one-use**, and **bound to the canonical action digest**.

**Invariant (normative):** approval invalid on any bound-field change.

## Consequences

- The digest binds tenant, actor, action, target resource, target branch, base SHA, patch SHA-256, policy version, evidence digest, expiry and execution ID; any mutation invalidates the approval.
- One-use semantics mean a consumed approval cannot be replayed; approval is denied by default on timeout or policy unavailability.
- Approvals are revalidated on resume after checkpoint (`awaiting_approval`); stale approvals from before a change are invalid.
- Merge/deploy/policy modifications require fresh authorization even after recovery (doc 38).
- CI and runtime both treat any bound-field change as revocation.