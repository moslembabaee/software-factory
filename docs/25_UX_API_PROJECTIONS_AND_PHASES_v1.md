> **v6.2 full-build rule:** Any MVP, optional, deferred or phase language below describes historical sequencing only. Every documented capability is mandatory at final delivery; see 37 and 43–48.

# UX Projections, APIs & Delivery Phases v1 — normative
## Runtime-to-product mappings
Work/Execution/Event remain authoritative for operations. Feature/Plan/Decision/Delivery are durable product records or explicitly versioned projections with traceable links to runtime evidence. Never infer accepted status solely from successful execution.

## Minimum product APIs (conceptual, versioned)
POST /projects; POST /projects/{id}/intake; GET /projects/{id}/plan; POST /plans/{id}/approve; GET /projects/{id}/features; GET /projects/{id}/decisions; POST /features/{id}/feedback; GET /projects/{id}/deliveries; GET /projects/{id}/budget; POST /approvals/{id}/decision; GET /projects/{id}/activity.
All mutations require authorization, idempotency keys where retryable, audit entries and optimistic concurrency / expected plan version.

## Phases
P0 Product foundation: create/import, conversation, versioned plan, feature status, basic budget, approval cards, two modes, acceptance evidence. Preserve runtime P0 reliability and security gates.
P1 Reviewable output: preview where supported, feedback/revision, deliverables, project decisions, notifications, export.
P2 Expansion: multi-project polish, integrations, collaborative roles, deployments, more granular automation profiles. No P2 capability is promised by P0 UI.

## Explicit non-goals for first MVP
No automatic production deployment, no guaranteed cost/time quote, no unlimited autonomous access, no multi-tenant billing, no universal preview for arbitrary repositories.
