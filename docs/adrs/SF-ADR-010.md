# SF-ADR-010 — Parent-Child Runs with Budget Escrow and Isolated Worktrees

- **Status:** Accepted
- **Date:** Phase 0 baseline
- **Source of record:** docs/43_BINDING_ADRS_AND_DECISION_POLICY.md (binding, v6.2)

## Context

Subflows and delegated child executions (LEGACY14-ADR-010) must not share mutable workspaces (LEGACY14-ADR-015) and must not multiply or silently exceed the parent's budget. Parent cancellation must reach active children, and child output must never auto-merge into the parent.

## Decision

Parent-child runs use **budget escrow** and **isolated worktrees**.

**Invariant (normative):** no implicit merge or budget multiplication.

## Consequences

- Each child has an immutable parent reference, its own worktree, an explicitly reserved budget carved out of the parent, independent leases and policy scopes.
- Reservations are atomically decremented and settled against actual usage; parent cannot exceed its total budget through child allocations; parent/child reservations never double-count.
- Parent cancellation cascades to active children; child completion never auto-merges into the parent.
- Conflict resolution produces reviewable patch sets tested against the current base before any merge.
- Unknown provider outcomes remain reserved until reconciled, so budget accounting stays correct.