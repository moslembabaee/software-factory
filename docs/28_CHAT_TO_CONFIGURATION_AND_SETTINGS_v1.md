# Chat-to-Configuration & Settings v1 — normative
## Three settings scopes
Account: identity, connected services, secret references, preferences. Project: repository, stack, budget, approval profile, environments, preview commands. Advanced runtime: model/agent routing, worker limits, tool capabilities, flow/rule versions and sandbox policy. Every setting has typed schema, owner, scope, default, validation, effective value, source and audit trail.
## Conversational update protocol
1. User requests change in Ask or Build. 2. Assistant extracts a proposed typed patch; never writes directly. 3. Backend validates schema, scope, policy, dependencies and caller authority. 4. UI shows before/after diff, effect, affected running work, risk, restart requirement and rollback feasibility. 5. User confirms proposal bound to immutable proposal hash and version. 6. Backend rechecks authorization/version (optimistic concurrency), applies atomically or rejects; records actor, timestamp and audit event. 7. UI reports confirmed outcome and effective values; failed apply leaves old configuration effective.
## Example
'Use PostgreSQL; budget $30; require manual approval for deployment' -> three typed project-setting changes with individual validation. No claim that PostgreSQL is provisioned merely because config was changed. Provisioning is a separate authorized Work.
## Security rules
Never display raw secret values after entry; use secret manager references and test-connection flows. Model cannot override immutable security baseline or its own approval requirement. Mode switching cannot change authorization. Higher-risk changes (network egress, secret scope, deploy target, policy changes) require independent approval. Running executions remain pinned to their config snapshot unless an explicitly documented safe migration is available.
## UI
Settings searchable by category, form editing and natural-language proposals share the same API. Provide undo only when reversible; otherwise show recovery instructions. Surface pending proposals and history. Changes can be rejected or edited before confirmation.
## API minimum
POST /projects/{id}/config-proposals; GET /config-proposals/{id}; POST /config-proposals/{id}/validate; POST /config-proposals/{id}/approve; POST /config-proposals/{id}/apply; GET /projects/{id}/effective-config; GET /projects/{id}/config-history. Use idempotency keys, expected_version and immutable hash for apply.
