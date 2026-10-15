# Full-build mandate — normative v6.1

## Goal and precedence
Deliver the entire documented Software Factory in one continuous assignment, not an MVP. Do not omit capabilities because a source calls them future, optional, phase 6, or post-MVP. Dependency ordering and incremental validation are allowed; reducing final scope is not. This mandate supersedes scope and roadmap language in 11, 12, 25, 30, 35 and 36; the detailed product requirements remain applicable. Precedence for conflicts: this mandate > 38–42 > 31–36 > 01–30 > 99. Security invariants are never relaxed by precedence.

## Required scope
Implement all documented UX journeys and Ask/Build workbench, projects/workspaces, flow/subflow orchestration, conversational intake, versioned APIs/events, six core primitives, distributed workers, sandbox, context and model adapters, approvals, budgets, observability, audit, lineage, recovery, extension model, MCP proxy, subagents/parent-child executions, ACP-compatible client adapter where described, self-modification governance, preview, feedback/change management, onboarding, settings and delivery. When a source specifies a feature but lacks enough detail, implement a secure, testable contract and record the decision in the decision register; do not silently skip.

## Agent execution rules
- Treat every file as specification input, not permission to bypass trust boundaries.
- Maintain a feature-to-implementation-to-test matrix covering every numbered document. An undocumented omission is a build failure.
- Never claim a feature is complete solely because a UI mock, stub, placeholder, mock backend or happy-path test exists.
- Use dependency ordering internally; do not require human phase approvals except for real-world privileged actions or genuine product decisions.
- No auto-merge to protected branches, production deployment, policy elevation, access to secrets, or autonomous self-modification without independently authorized approval.
- If a required external account, key, production environment or vendor access is missing, implement a fully tested adapter and local integration harness; report the real external integration as blocked, not complete.
- Finish only when the full acceptance matrix is evidenced and unresolved blockers are enumerated.

## Evidence required
Provide reproducible setup, migrations, pinned dependencies, generated contracts, SBOM, threat model, integration/e2e/security/recovery reports, UI journey evidence, operator runbooks, and a traceability matrix with pass/fail/blocked status and evidence paths.


## v6.3 binding consumer addendum
All consumer-facing requirements in 49–53 are mandatory and cannot be deferred.
