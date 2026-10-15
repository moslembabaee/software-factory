# Normative state machines and concurrency rules

All transitions require `(tenant_id, entity_id, expected_version, actor, cause_event_id)` and a transaction that increments `version`, inserts an append-only event and outbox row. Conflicts return 409 `VERSION_CONFLICT`. Event consumers are at-least-once and deduplicate by event_id. Terminal states are immutable except through a new Execution.

## Execution state transition table
| From | To | Guard | Side effect |
|---|---|---|---|
| queued | running | leased worker, valid policy and budget | emit execution.started |
| queued | cancelling | owner request | revoke pending lease |
| running | awaiting_approval | immutable patch + test evidence published | release worker lease, checkpoint |
| running | verifying | no protected effect required; proposal exists | independent verifier |
| running | needs_reconciliation | remote effect uncertain | block further effects |
| running | budget_exhausted | no available reservation | revoke tool capability |
| running | failed | unrecoverable verified error | persist error evidence |
| running | cancelling | authorized cancellation | cascade children and revoke tokens |
| awaiting_approval | verifying | fresh one-use bound approval and unchanged base/policy/tests | consume approval atomically |
| awaiting_approval | cancelling | cancellation or denial | invalidate approval |
| verifying | completed | all required tests, approvals, effects confirmed | publish immutable delivery |
| verifying | awaiting_approval | base/patch/policy changed | request new approval |
| verifying | needs_reconciliation | effect outcome unknown | freeze external actions |
| verifying | failed | verified test or integrity failure | preserve artifacts |
| needs_reconciliation | verifying | outcome verified, still approved and budget valid | resume at checkpoint |
| needs_reconciliation | awaiting_approval | approval stale after reconciliation | require reapproval |
| needs_reconciliation | failed | confirmed irrecoverable error | record adjudication |
| cancelling | cancelled | all active children stopped, credentials revoked | finalize |
| cancelling | needs_reconciliation | remote effect unresolved | keep locked pending adjudication |
| any nonterminal | failed | authorized fatal invariant violation | incident audit |

`unknown` is an **Effect status**, not an Execution terminal state. `cancelling` is nonterminal. `budget_exhausted`, `cancelled`, `failed`, `completed` are terminal. No transition from completed to another state. Approval denial routes through cancelling. Worker loss leaves Execution running only until lease expiration; scheduler reclaims with increased fencing token and restores checkpoint; never retries uncertain effects.

## AgentRun states
created -> initializing -> reasoning -> tool_pending -> tool_running -> observing -> reasoning; reasoning -> verifying -> completed (proposal only). tool_pending -> awaiting_approval -> reasoning after resumed authorization. Any active state -> failed/cancelled/budget_exhausted/stalled. Each step has monotonic sequence. AgentRun completed MUST NOT set Execution completed.

## External effect states
prepared -> dispatched -> confirmed | unknown | rejected; unknown -> confirmed | rejected | manual_review. Only safe idempotent provider operations may be retried with same provider key after remote lookup; otherwise manual_review. All effect rows include action digest, provider request id, lease fence, tenant, execution and observed response hash.

## Cancellation and race rules
Cancellation CAS wins against any not-yet-committed effect. A previously dispatched effect must be reconciled; never claim it was rolled back without proof. Child cancellation fan-out is durable and awaited before parent cancelled. Approval decision and execution transition share a transaction; replayed decision returns 409. Worker lease fencing checked both before dispatch and at commit.
