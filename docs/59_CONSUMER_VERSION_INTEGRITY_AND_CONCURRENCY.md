# Consumer version integrity and concurrency — v6.5 (normative)

## Immutable identity chain
A preview points to immutable `project_id, repository_id, commit_sha, build_id, artifact_digest, environment_id`. A feedback record points to immutable `preview_id, commit_sha, selector_snapshot, screenshot_digest, author_id`. A revision points to parent commit and feedback IDs. An acceptance decision points to `build_id, commit_sha, test_evidence_digest, acceptance_criteria_version, actor_id`. Delivery references the exact accepted build and digest. Never derive these references from a mutable `latest` pointer.

## Preconditions and races
All mutation endpoints require authenticated actor, scoped permission, `Idempotency-Key` and expected version (`If-Match` or explicit version field). Within one database transaction: lock the project/revision aggregate; validate ownership, status, exact digest and expected version; append audit event; apply state change; commit. Concurrent writes with stale versions return HTTP 409 `VERSION_CONFLICT`, not last-write-wins. Reusing a key with a different payload returns 409 `IDEMPOTENCY_KEY_REUSED`; same payload returns the original response.

## Invariants
- An acceptance is invalidated for delivery when the accepted artifact digest or test evidence changes.
- A delivery cannot transition to delivered unless its build digest equals the accepted build digest and required tests are green.
- A preview may expire or fail without changing the associated immutable build identity.
- Feedback attached to an old preview remains readable and cannot silently migrate to a new preview.
- Rollback creates a new revision referencing an old immutable artifact; it does not rewrite history.
- A successful tool invocation does not mean user acceptance.

## Failure cases
Test concurrent acceptance vs revision, duplicate delivery requests, changed preview during feedback, expired preview URL, broken artifact signature, missing evidence, crash after external publish but before acknowledgment, and retry after timeout. Externally uncertain operations must be reconciled before retry.
