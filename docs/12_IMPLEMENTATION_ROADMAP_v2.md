> **v6.2 full-build rule:** Any MVP, optional, deferred or phase language below describes historical sequencing only. Every documented capability is mandatory at final delivery; see 37 and 43–48.

# Implementation Roadmap v3 — Dependency-Gated

Each phase has an exit test. **Phase 2 is a prototype, not the operational MVP.** Operational MVP requires Phase 8 and security/recovery gates.

| Phase | Build | Exit gate |
|---|---|---|
| 0 — Persistence | schema migrations, Work/Execution/Event, transition coordinator, transaction+outbox/inbox | AT-02, AT-03 |
| 1 — Workbench | queue, timeline, Decisions Needed, Deliverables, Project Health | visible state and decision reasons |
| 2 — Local prototype | one agent adapter, local sandbox, verifier, git artifact | AT-09; no autonomous production write |
| 3 — Authorized GitHub | signed webhook, identity mapping, effect gateway, exact approvals | AT-08, AT-12 |
| 4 — Durable flow | pinned versions, step runs, waits, sub-flow, resume | AT-04 |
| 5 — Conversation | proposal-only intake, selective human acceptance, lineage | no implicit Work acceptance |
| 6 — Supervision | lease/epoch, unknown reconciliation, cancellation, budget, second adapter | AT-01, AT-05, AT-10, AT-11 |
| 7 — Parallel workers | container isolation, scoped credentials, capacity, merge serialization | AT-06, AT-16 |
| 8 — Protected evolution | proposal/diff hash, activation, emergency stop, rollback and restore drill | AT-07, AT-14, AT-15; operational MVP gate |
| 9 — Extension | scheduled jobs, skill and connector registry | contract and permission tests |
| 10 — Routing | history-based simple policies after real data | measurable reliability and cost |

**Cross-cutting from Phase 0:** security threat model, audit redaction, state ownership, idempotency, resource limits and test harness. No later phase may defer a P0 required by an earlier release gate.


## Updated implementation sequence (v6)

Use `35_BUILD_PLAN_AND_ACCEPTANCE.md` as the authoritative dependency-ordered implementation plan for the integrated coding runtime. Previous phases remain product context, not an independent delivery plan.
