> **v6.1 scope override:** All phases including phase 6 and every source feature are mandatory in final delivery. Phases indicate dependency order only. See 37 and 39.

# Software Factory — Build Plan, Deliverables and Acceptance

**Status:** actionable implementation baseline. This is a specification, not a claim that the system is already implemented.

## Suggested monorepo
```text
software-factory/
  apps/web/                 # Ask/Build workspace
  apps/api/                 # public API + auth
  apps/scheduler/           # durable queue/leases
  apps/agent-worker/        # ephemeral worker entrypoint
  packages/contracts/       # API schemas + event types
  packages/factory-core/    # six primitive domain model
  packages/agent-runtime/   # model loop + checkpoints
  packages/context-manager/
  packages/tool-gateway/
  packages/policy-engine/
  packages/event-projections/
  infra/sandbox/
  infra/migrations/
  tests/contract/
  tests/e2e/
  docs/
```

## Baseline technology choices (binding defaults; see SF-ADR-001 in 43)
TypeScript for API/UI/contracts, TypeScript for worker runtime, PostgreSQL for transactional storage, PostgreSQL-backed durable queue, S3-compatible object storage, OCI isolated workers. Prefer existing stack if project already has one; do not silently replace it. CI: lint, typecheck, unit, contract, integration, security and e2e tests.

## Dependency-ordered delivery phases
| Phase | Deliverable | Exit gate |
|---|---|---|
| 0 | ADRs, repo skeleton, schemas, local compose | reproducible setup + CI green |
| 1 | Core Work/Execution/Event APIs, migrations, auth | idempotent create and tenant isolation tests |
| 2 | queue, worker leases, sandbox, tool gateway | kill/retry and escape tests pass |
| 3 | model adapter, bounded agent loop, context, patch/tests | agent completes seeded repo task within budget |
| 4 | Ask/Build UI, diff preview, approvals | end-to-end human-reviewed patch flow |
| 5 | recovery, observability, budget and security hardening | failure injection, audit and quota tests pass |
| 6 | mandatory MCP, subagents, ACP, advanced automation | complete integration tests + threat review |

## First vertical slice user story
Given an authenticated user and sample repo with a failing test, when they request a fix in Build mode, the system creates Work and Execution, runs the coding agent in a disposable sandbox, produces a patch and passing test report, requests review, and merges only after explicit approval. On denial, no protected branch changes occur.

## Acceptance test IDs
- **AT-AGENT-01:** duplicate create requests produce one Work/Execution.
- **AT-AGENT-02:** worker crash + lease expiry does not double-commit effects.
- **AT-AGENT-03:** repeated callback event IDs are deduplicated.
- **AT-AGENT-04:** path traversal and symlink escape are denied.
- **AT-AGENT-05:** prompt-injected repository instructions cannot bypass policy.
- **AT-AGENT-06:** protected-branch merge requires bound, nonexpired approval.
- **AT-AGENT-07:** budget exhaustion stops tool/model calls and suspends run.
- **AT-AGENT-08:** cancellation terminates sandbox and revokes credentials.
- **AT-AGENT-09:** model provider failure retries with backoff without losing audit history.
- **AT-AGENT-10:** patch + tests + artifacts are traceable to Work and Execution.
- **AT-AGENT-11:** Ask mode cannot write to repository.
- **AT-AGENT-12:** cross-tenant Work, events and artifacts are inaccessible.

## Definition of done
Every feature requires owner, versioned contract, migration (if any), unit/contract/e2e coverage, threat considerations, metrics, runbook, documentation and demonstrable acceptance evidence. A phase is not complete on documentation alone.
