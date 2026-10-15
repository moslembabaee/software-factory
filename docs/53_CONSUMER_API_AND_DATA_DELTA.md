# Consumer-facing API and data delta — binding design requirements v6.3
The v6.2 OpenAPI/SQL files are baselines, not full coverage. The implementation must add validated request/response schemas, migrations, authorization and integration tests for these resources. These examples define *minimum* fields; names must be reconciled with existing canonical entities and no parallel source of truth introduced.
## Required resources
- `POST /projects/{projectId}/intake` -> versioned requirements with original text, assumptions, acceptance criteria, locale and idempotency key.
- `GET /projects/{projectId}/consumer-status` -> feature progress evidence, blockers, decisions, spend summary, latest verified preview, active release.
- `POST /projects/{projectId}/previews` and `GET /previews/{previewId}` -> build id, commit SHA, state, health, expiry, access policy and safe URL.
- `POST /previews/{previewId}/feedback` -> target selector or coordinates, viewport, redacted screenshot reference, comment, originating build and idempotency key.
- `GET /projects/{projectId}/revisions` and `GET /revisions/{id}/compare?other=...` -> immutable versions, changes, evidence, preview references.
- `GET /projects/{projectId}/cost-forecast` -> spent, reserved, authorized cap, estimate interval, assumptions, updated_at.
- `GET /projects/{projectId}/delivery-receipt` -> verified release, artifact hashes, export references, test evidence, instructions and caveats.
- `POST /projects/{projectId}/acceptance-decisions` -> authorized reviewer, revision id, decision, criterion ids and optimistic concurrency token.
## Data invariants
All mutable resources require project scope and ownership checks; cross-project references rejected. Preview/feedback/revision identifiers immutable. Sensitive screenshot assets encrypted, access-scoped and retention-controlled. Redaction failures block capture. Acceptance bound to exact revision + evidence hash; revisions invalidate affected acceptance. Use optimistic concurrency or equivalent to avoid lost decisions. Explicit retention/deletion/export policy for feedback and screenshots.
## Error contract
Use consistent machine-readable error code, localized plain-language summary, correlation id, retryability flag and recommended safe action. A retryability flag must be false for unknown non-idempotent external effects. Version all consumer-facing contracts and publish generated OpenAPI + schema conformance tests.
