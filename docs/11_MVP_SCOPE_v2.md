> **v6.2 full-build rule:** Any MVP, optional, deferred or phase language below describes historical sequencing only. Every documented capability is mandatory at final delivery; see 37 and 43–48.

# MVP Scope v3 — Release Definitions

## Product target
One owner, one repository, at least two agent adapters, concurrent isolated execution, conversational intake, versioned flow/sub-flow, GitHub optional control, protected self-change, visible recovery. No multi-tenancy.

## Three release milestones
**Technical Prototype (through Phase 2):** one agent, local isolated non-sensitive repository, transactional events/outbox, Workbench visibility, basic verification. Not approved for autonomous real-repo writes.

**Operational MVP (through Phase 8):** all v2 Must Have capabilities plus v3 reliability, security, durable flow, budget, acceptance and crash-injection gates. Includes two parallel execution slots, scoped sandbox credentials, protected self-change and emergency stop. This is the first release suitable for a real project.

**Advanced Factory (Phase 9+):** extensibility, history-based routing, remote workers as needed. Multi-tenant remains separate future scope.

## Operational MVP definition of done
- One-week real repository pilot with audit trail and no unresolved P0 issues.
- All AT-01..AT-16 in `17_ARCHITECTURE_ACCEPTANCE_TESTS_v1.md` pass or documented operator drills pass.
- No unscoped secret access; no direct worker external write; no stale-epoch publication.
- Recovery after process restart and worker disconnect demonstrated.
- Work success is distinguished from verification, acceptance and delivery.
- Two concurrent agents cannot corrupt shared workspace or silently overwrite target branch.
- Human can approve exact diff, reject it, pause, cancel, inspect uncertainty and use emergency stop.
- Costs, attempts, and budgets visible.

## Out of scope
BPMN, generic marketplace, billing, multi-tenant enterprise, optimizer/ML routing, autonomous security-policy rewriting.


## Integrated MVP gate (v6)

First ship a single-repository, single-agent vertical slice: intake → Work → Execution → sandboxed agent → patch/tests → preview/diff → human approval → merge/delivery. Multi-agent planning, self-modification, cloud handoff and full ACP are post-MVP. See `35_BUILD_PLAN_AND_ACCEPTANCE.md`.
