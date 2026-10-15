# ADR Baseline v2

## LEGACY14-ADR-001 — Six Core Primitives

Work, Actor, Execution, Reference, Relation, Event.

## LEGACY14-ADR-002 — Rules/Flows Are Mechanisms

They coordinate Core entities but are not Core entities.

## LEGACY14-ADR-003 — Actor Is Opaque

Internal topology is not modeled unless Factory coordinates it.

## LEGACY14-ADR-004 — Actor ≠ Worker ≠ Sandbox

Identity, execution host and isolation boundary are separate.

## LEGACY14-ADR-005 — Execution Is Attempt

Retry/failover = new Execution.

## LEGACY14-ADR-006 — Running ≠ Progressing

Progress must be observable separately.

## LEGACY14-ADR-007 — Workbench Is Coordination UI

It is not replacement for Git/GitHub/Jira source-of-truth roles.

## LEGACY14-ADR-008 — Existing Tools Are Optional Control Surfaces

Equivalent commands may come from Workbench/GitHub/Jira/Slack/API.

## LEGACY14-ADR-009 — Conversation May Precede Work

Issue is not mandatory starting point.

## LEGACY14-ADR-010 — Flow Supports Sub-flow

Keep vocabulary minimal; no BPMN engine.

## LEGACY14-ADR-011 — Flow Changes Are Versioned

Active behavior does not silently mutate.

## LEGACY14-ADR-012 — Self-modification Has Higher Authority

Factory behavior change follows proposal → diff → approval → activation.

## LEGACY14-ADR-013 — Emergency Stop Is Outside Agent Authority

Agents cannot re-enable it.

## LEGACY14-ADR-014 — Distributed Execution Uses Workers

Worker runtime is replaceable; Core unaffected.

## LEGACY14-ADR-015 — Isolation Before Parallelism

No multi-agent parallel execution on shared mutable workspace.

## LEGACY14-ADR-016 — External Systems Keep Ownership

Reference instead of full mirror by default.

## LEGACY14-ADR-017 — No Optimizer Before Data

Routing starts rule-based.

## LEGACY14-ADR-018 — No Plugin Framework Before Distribution Need

Folders/registries first.

## LEGACY14-ADR-019 — Control Plane Starts Monolithic

Do not split services before real failure/load boundary.

## ADR-020 — Worker Is Separate Early

Because remote/distributed execution is a known target, Worker contract should be explicit from early phases.


---

## v3 adopted ADRs

- **ADR-021 — Transactional State + Outbox:** relational lifecycle state is authoritative; committed events/outbox share transaction; at-least-once delivery with dedup.
- **ADR-022 — Single Transition Authority:** one coordinator validates and commits lifecycle transitions; other mechanisms propose commands.
- **ADR-023 — Lease/Fencing + Effect Gateway:** stale workers cannot publish through authorized external write paths; unknown effects require reconciliation.
- **ADR-024 — Sandbox Is a Security Boundary:** worktrees are not sufficient; container/VM and scoped credentials required for shell-capable agents.
- **ADR-025 — Durable Version-Pinned Flows:** persisted step runs/waits and stable child keys, no silent mid-run config migration.
- **ADR-026 — Digest-Bound Approval:** approval is identity/role checked and tied to immutable subject content.
- **ADR-027 — Distinct Outcomes:** execution, verification, acceptance and delivery are separately tracked.
- **ADR-028 — Release Milestones:** prototype, operational MVP and advanced factory have distinct gates.
- **ADR-029 — Single-Owner MVP:** multi-tenant product requires dedicated ADR and threat model.
- **ADR-030 — No Exactly-Once External Effect Promise:** effects rely on provider idempotency/receipts or manual reconciliation.
