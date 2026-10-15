# Full-build test oracle and handoff — v6.2

## Reproducible checks (required in CI)
- CONTRACT-01: validate OpenAPI 3.1 document and generated client/server type parity; reject unknown fields and invalid enums (400/422); require every operationId unique.
- DB-01: migrate fresh PostgreSQL and migrate existing fixture forward; FK, unique, RLS, append-only audit, CAS and outbox atomicity verified with two concurrent transactions.
- RACE-01: 100 concurrent requests with same idempotency key and same payload create exactly one Work; different payload with same key returns 409.
- RACE-02: 100 simultaneous reservation attempts never exceed configured cap; child escrow + parent spend never exceed parent cap.
- STATE-01: enumerate every allowed transition in 44, assert allowed ones succeed and every disallowed pair fails; crash between event/outbox commit is atomic.
- RECOVERY-01: inject process kill before remote dispatch, after dispatch but before receipt, and after receipt but before local commit; assert no duplicate protected effect and unknown stays blocked until reconciled.
- APPROVAL-01: independently mutate each bound field (base SHA, patch hash, target, policy, evidence, reviewer, expiry), assert prior approval unusable.
- SECURITY-01: traversal, symlink, network egress, metadata endpoint, secret extraction, Docker socket and cross-tenant access all denied; production untrusted mode disabled if any isolation probe fails.
- AGENT-01: fixture repository with failing test; agent proposes patch; tests run; user denies -> protected branch unchanged; fresh approval -> one merge.
- SUBAGENT-01: parent spawns 3 children, cancel parent during active calls; all children terminal or reconciled, no unauthorized merge and budget conserved.
- CONNECTOR-01: malicious MCP tool response cannot override policy; ACP disconnect/resume preserves event sequence and scopes.
- UX-01: automate each user journey in docs 19–30 with actual backend, including keyboard navigation, error states, refresh and permission denial.
- OPS-01: clean install, backup restore, key rotation, worker restart, migration rollback plan and incident drill with evidence artifacts.

## Evidence format
For each case persist `id, source_doc, code_path, test_path, command, commit_sha, timestamp_utc, environment, result(PASS|FAIL|BLOCKED), log_sha256, artifact_path`. CI fails on FAIL or missing mapping. BLOCKED is permitted only for real third-party credentials, operator-selected region/hosting or external production environment; blocked gates prevent unconditional production-ready status.

## Mandatory agent handoff
Implement the **entire** documented product in one assignment. Sequence internally as needed. Never skip an advanced feature because it was once marked MVP/future/optional. Follow 43–48 over historical conflicts, but never weaken security invariants. Produce full generated API contract, migrations, coverage ledger, passing test evidence, and a blocker report. Do not claim complete from docs, mocks or untested adapters. Real privileged actions require external approval.


## v6.3 binding consumer addendum
Consumer gates CX-01..CX-16 are additional blocking acceptance gates; see 52. A build without these gates cannot be called fully delivered.


## v6.4 consumer acceptance gate
Enforce 54–56: compile/validate OpenAPI, apply migration on fresh PostgreSQL, execute CX tests against real services, and reject delivery on revision/evidence mismatch. Tests not executed must be reported as unverified.
