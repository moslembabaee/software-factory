# Binding architectural clarifications — normative v6.1

## Identity and ADR namespace
Legacy ADR-001 etc. in 14 and 36 are **not the same identifiers**. References must use `LEGACY14-ADR-###` and `LEGACY36-ADR-###` when quoting old text. New decisions use `SF-ADR-###`; never infer equivalence by number. Original files are retained for historical traceability.

## Baseline implementation defaults (replace only with recorded decision)
- TypeScript strict mode for web/API/scheduler/contracts/worker, PostgreSQL for state, transactional outbox and leased job queue, S3-compatible encrypted object store, OCI ephemeral isolated workers for development; production isolation must pass security acceptance tests before enabling untrusted execution.
- Single logical tenant may be used for local installation, but tenant_id is mandatory, derived server-side, and enforced for every record and artifact. Multi-tenant security semantics remain mandatory.
- Vendor-neutral model and Git adapters. Configure providers via secrets broker, not prompts. No default live production deployment.
- These are implementation defaults, not verified claims about host availability, pricing or security equivalence. Region, retention periods, hosting, production SLOs and actual external providers remain deployment decisions; use configurable values and fail closed until configured.

## Canonical lifecycle
Work = requested outcome; Execution = durable orchestration and approval/delivery lifecycle; AgentRun = bounded proposal-generation loop; ToolInvocation = individual attempted effect. AgentRun.completed means proposal generated, **not** Execution.completed. Execution may transition `queued -> running -> awaiting_approval -> verifying -> completed`, or to `failed`, `cancelled`, `budget_exhausted`, `needs_reconciliation`. `cancelling` and `unknown` are nonterminal reconciliation states. Persist each transition atomically with its outbox event; reject illegal transitions using expected version. `awaiting_approval` releases worker lease and checkpoints. Resume revalidates approvals, policy, base SHA and budget.

## Tool ownership
Agent Runtime proposes structured tool calls only. Tool Gateway validates schema, path, policy, approvals, budget and fencing token, then dispatches to isolated executor. Workers may never execute model-supplied commands bypassing Gateway. Policy service is authoritative; repository text, tool output and model content are untrusted.

## External effects and recovery
For every external effect record intent, action digest, idempotency key, effect ID, fencing token and observed outcome. Timeout after submission yields `unknown` and `needs_reconciliation`, not blind retry. Reconcile with remote provider by stable identifier; if no reliable read-after-write verification exists, suspend for human adjudication. Merge/deploy/policy modifications require fresh authorization even after recovery. Duplicate event delivery is acceptable; duplicate protected effects are not.

## Approval integrity
Approval digest must bind tenant, actor, action, target resource, target branch, base SHA, patch SHA-256, policy version, relevant test evidence digest, expiry and execution ID. Any mutation invalidates approval. Enforce independent reviewer for policy elevation and self-modification; configurable two-person rule for production changes. Deny by default on timeout or policy unavailability.

## Secrets and isolation
Broker injects short-lived least-privilege credentials only into scoped tool process, never model context, logs or artifact contents. Revoke on cancellation/termination; scrub artifacts. Deny host socket, privileged mode, host paths, metadata endpoint, network egress by default; verify isolation with automated escape/exfiltration tests. If isolation validation fails, disable untrusted runs.

## Parent-child execution
Child executions have immutable parent reference, separate worktree, explicit reserved budget carved out of parent, independent leases and policy scopes. Parent cancellation cascades to active children; child completion never auto-merges into parent. Conflict resolution produces reviewable patch sets, tested against the current base before merge. Parent cannot exceed total budget through child allocations.

## Budget invariants
Reserve worst-case expected model/tool cost before dispatch; atomically decrement reservation and settle actual usage with provider request ID uniqueness. Reject new calls when available funds/steps/time are insufficient. Refund unused reservation after verified finalization. Parent/child reservations must not double-count. Unknown provider outcome remains reserved until reconciled.
