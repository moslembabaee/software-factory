# Consumer lifecycle and error policy — binding v6.4

## Immutable identity and version safety
- A revision is immutable and identified by `(tenant_id,project_id,id,commit_sha,evidence_digest)`. Preview points to exactly one revision. Its URL is exposed only if health=healthy, state=ready, authorization passes, and expiry is in future.
- Feedback references original preview and revision forever. A newer preview does not rebind old feedback. Screenshot storage is private; redaction must succeed before upload.
- Acceptance is signed by an authenticated reviewer, scoped to project and revision, and includes exact evidence digest and criteria IDs. Optimistic concurrency checks `expected_version`; mismatch returns `STALE_REVISION` 409. No automatic acceptance.
- Delivery requires matching accepted decision, immutable evidence digest and revision, verified critical journeys, reproducible artifact hashes, and approved export policy. A new revision cannot inherit acceptance. Delivery of a changed revision requires fresh acceptance.

## State transitions
| Resource | Allowed transitions | Terminal behavior |
|---|---|---|
| Preview | requested→building→verifying→ready; requested/building/verifying→failed; ready→expired/revoked; failed→revoked | never reactivate same preview; create new preview |
| Feedback | open→triaged→implemented/rejected; triaged→open | no mutation of origin preview/revision |
| Acceptance | no mutation: append accepted/rejected decision for exact revision and evidence | new decision requires new version and authorization |
| Delivery | prepared→delivered/revoked; delivered→revoked | revoked receipt retained for audit; new receipt for redelivery |

## Errors and safe UI actions
| HTTP | Code | Safe user action | Retryable |
|---|---|---|---|
| 422 | VALIDATION_FAILED | correct highlighted field | no |
| 403 | FORBIDDEN | request project access | no |
| 404 | NOT_FOUND | return to project | no |
| 409 | CONFLICT | refresh status and resolve | no |
| 409 | STALE_REVISION | review current revision before deciding | no |
| 410 | PREVIEW_EXPIRED | request new preview | no |
| 409 | PREVIEW_NOT_READY | wait for verification | yes for GET only |
| 422 | REDACTION_BLOCKED | remove sensitive material and recapture | no |
| 409 | ACCEPTANCE_MISMATCH | review exact evidence and revision | no |
| 409 | BUDGET_LIMIT | authorize revised cap explicitly | no |
| 409 | UNKNOWN_EXTERNAL_EFFECT | reconcile or manual review, never blind retry | no |
| 429 | RATE_LIMITED | retry after server-provided delay | yes for safe/idempotent operations |
| 500 | INTERNAL_ERROR | show correlation ID, allow support escalation | no by default |

All errors return `ApiError`, including localized plain-language `message`, correlation ID and safe action. Never expose raw stack traces. POST idempotency is scoped by tenant, actor, route, request digest, and key; conflicting reuse returns 409. Authentication, project membership and explicit grants must be checked before resource lookup results are exposed. Database RLS is defense in depth, not a substitute for authorization.

## Operational enforcement
Database constraints cannot alone prove that a delivery receipt matches accepted evidence, nor that preview URL is currently healthy. Enforce these under transaction-level locks in domain service; test stale reads, race conditions and cross-tenant references. Use append-only audit events and signed artifact checksums. Screenshot encryption, retention, deletion and export must be implemented by storage service with per-tenant policy.
