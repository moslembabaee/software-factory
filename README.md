# Software Factory full-build pack v6.3

[![CI](https://github.com/moslembabaee/software-factory/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/moslembabaee/software-factory/actions/workflows/ci.yml)

This is a specification pack, not implemented software. v6.3 preserves all v6.2 files and adds binding consumer-experience requirements 49–53, covering simple-mode workflow, verified previews, visual feedback, cost, recovery, delivery and test gates. See docs/00_START_HERE.md.

# Software Factory Full Build Pack v6.2

Full scope retained. Start with docs/00_START_HERE.md and docs/48_DETERMINISTIC_ACCEPTANCE_AND_HANDOFF.md. This archive contains specifications and **reference** SQL/OpenAPI contracts, not a built product. The reference contracts require expansion for all capability families before implementation acceptance.

Version 6.5 adds release evidence gates, immutable version-binding rules, concurrency policy and negative security/consumer test matrix. The ZIP contains specifications, not working application code.

TypeScript workspaces extend `packages/tsconfig/base.json`. It enables strict
checking, exact optional properties, checked indexed access, unused-code checks,
and declaration checking. `tsconfig.base.json` and the package's `strict.json`
are compatibility aliases for that same configuration. Each source workspace
sets its own `rootDir` and `outDir`, so generated files stay in its ignored
`dist/` directory. The root `tsconfig.json` is a solution containing project
references; the config-only package is not a build target.

Run `npm install` to install the shared compiler and development tools, then:

- `npm run build` (or `npx tsc --build`) builds all referenced projects.
- `npm run typecheck` and `npm run lint:tsc` check every referenced workspace
  through the same incremental build. `tsc --noEmit` on the root solution alone
  does not traverse project references.
- `npm test` runs the TypeScript unit tests and a compiler regression check. The
  latter builds an isolated fixture using the real configurations, introduces
  an intentional type error in every source workspace, and checks that
  `lint:tsc` reports each one.
- `npm run lint` applies the TypeScript-ESLint strict type-checked flat preset.
- `npm run format` / `npm run format:check` use the shared `.prettierrc`.
- `npm run dev` starts the Fastify API with `tsx watch` and the API's strict
  TypeScript configuration. The runner transpiles; run `npm run typecheck` for
  compiler diagnostics.

New source workspaces should extend the shared base, set local build output
paths, and add their `tsconfig.json` to the root references. Add references to
upstream workspace projects as dependencies are introduced. Workspace compiler
configs also include local `*.config.ts` files; root tooling uses
`tsconfig.tools.json`. Run `npm run typecheck && npm test` to verify changes.

Phase 1 API contracts live in `docs/46_OPENAPI_BASELINE.yaml`. Operations marked
`x-phase: 1` cover the implemented health, CRUD, execution, event and artifact
routes; unmarked approval and consumer operations describe later phases. The
`tests/contract/src/phase1.test.ts` Vitest suite checks the complete route
inventory and compares request and response schemas with that YAML. It also
validates injected HTTP responses independently, including errors, pagination,
idempotency and empty responses. Run it with
`npx vitest run tests/contract/src/phase1.test.ts`, or as part of `npm test`.
These contract tests use a tenant database fixture; live PostgreSQL RLS checks
remain in the storage integration suite enabled by `TEST_DATABASE_URL`.

The API exposes unauthenticated `GET /health` for liveness. Under `/api/v1`,
`projects`, `works`, `references`, and `relations` support POST, GET (list and
item), PATCH, and DELETE. Lists accept `limit` (1–100, default 50) and `offset`
(default 0). Creating a work requires an `Idempotency-Key` header (8–128
characters); updating one requires its current `version`. Actor and execution
reads and the execution lifecycle routes follow the OpenAPI contract above.

Embed `buildApp({ authenticate })` or `startServer(port, { authenticate })`
from `apps/api/src/index.ts` with a credential verifier that resolves a trusted
`{ tenantId, actorId }`, or returns `null` for invalid credentials. Both IDs must
be UUIDs, and the actor must exist in that tenant. The default authenticator
denies all resource requests; standalone startup serves health but needs this
integration for authenticated CRUD. Client tenant/actor headers never establish
identity. The entry point exports `Authenticate` and `AppOptions` for adapters.

The application pool reads `API_DATABASE_URL`, then `DATABASE_URL`, then the
local development URL. Use administrator credentials only for migrations and
seeding. After migrating, an administrator can grant a dedicated login role
the permissions needed by the current API (configure its password separately):

```sql
CREATE ROLE sf_api LOGIN NOSUPERUSER NOBYPASSRLS;
GRANT CONNECT ON DATABASE software_factory TO sf_api;
GRANT USAGE ON SCHEMA public TO sf_api;
GRANT SELECT ON actors, artifacts TO sf_api;
GRANT SELECT, INSERT, UPDATE, DELETE
  ON projects, works, "references", relations TO sf_api;
GRANT SELECT, INSERT, UPDATE ON idempotency_keys, executions TO sf_api;
GRANT SELECT, INSERT ON events, outbox TO sf_api;
GRANT SELECT, DELETE ON worker_leases TO sf_api;
```

Set `API_DATABASE_URL` to that login. Each authenticated resource request opens
a transaction, checks the database role, and sets `app.tenant_id` and
`app.actor_id` locally before accessing tenant data. Success commits; failure
rolls back; returning a pooled
connection clears the identity. Fastify closes its owned pool on shutdown;
callers supplying a database remain responsible for closing their own pool.

With `TEST_DATABASE_URL` set, `apps/api/src/__tests__/resources.integration.test.ts`
tests HTTP CRUD against a freshly migrated database through a non-superuser
role. It checks persistence, cross-tenant reads and mutations, foreign-key
isolation, optimistic versions, rollback, and identity cleanup while reusing a
single pooled connection. It creates and removes its own database and role.

### Repository agent runtime

`python3 orchestrator.py` runs the trusted repository automation loop used by
`watchdog.sh`. It requires Python 3.10+, Git, the authenticated `claude`, `codex`
and `agy` CLIs, and the project's Node/npm installation on `PATH`. GitHub-linked
publication requires authenticated `gh` access with permission to create PRs,
request reviews, and merge under the repository's branch rules. Use a dedicated
checkout on the base branch with an `origin` remote, Git author identity, and a
valid `maintainers.json`. Successful verification publishes a `factory/<task-id>`
branch and opens a PR targeting `main` (or `--branch`).

Run `python3 orchestrator.py --once` to process at most one approved or ready task,
or use `--project-root`, `--repo`, `--remote` and `--branch` to target another checkout.
The defaults resolve paths relative to the script and use
`moslembabaee/software-factory`. Each task must contain `id`, `title`,
`description`, `status` and a nonempty trusted `verification_cmd`; the Software
Factory gate is `npm run typecheck && npm test`. Commands run from the checkout.

Only `approved` tasks are claimed. Waiting tasks remain pending approval, an
empty queue idles, and `STOP_IMPROVEMENTS` prevents further dispatch. One process
holds the repository lock during each task. The agent chain is Claude → Codex →
Antigravity, rotated to start with `assigned_agent`. Each provider gets one
attempt. Missing CLIs, timeouts, nonzero exits, explicit quota errors (including
Antigravity's `AGY_ERROR` with exit code zero), and failed verification advance
to the next provider with bounded failure feedback. A provider quota requires
that provider's quota to reset; it does not require an implementation repair.

Verification failures are analyzed locally from the bounded, combined stdout and
stderr capture before reducing the stored log tail. The reflection engine extracts
TypeScript errors, test names, assertions, exceptions, stack traces and timeouts.
Structured `failure_analysis` and `failure_summary` fields are saved on the task,
verification record and failed attempt. The next provider receives a remediation
prompt naming the failure, implicated files and full verification command. A later
approval reuses saved diagnostics; successful verification clears the live summary
while retaining failure history. Reflection uses no additional provider calls and
preserves the existing one-attempt-per-provider retry limit and process deadlines.

Runtime telemetry is persisted atomically with each task in the existing roadmap
store. Per-attempt records track reported or estimated input/output tokens,
estimated USD cost, agent and verification latency, and failure mode (including
timeouts). Spend is recorded before verification and survives approval/restart.
Retry rate is the number of attempts after a task's first attempt divided by all
attempts; it does not depend on the resettable `retry_count` lifecycle field.

Set `budget_cap_usd` on a task or `--budget-cap-usd` on the worker. Zero blocks
dispatch; an explicit task value of null removes the limit. Caps are rechecked
against live state before dispatch and after every invocation, preventing further
verification/failover/publication once reached. A running invocation can overshoot
its cap; this is not a provider-side billing limit. Token character estimates
and default per-agent rates are approximate. Configure rates in USD per million
tokens with `--token-rates-json '{"codex":{"prompt":2.5,"completion":10}}'`;
use `--agent-timeout` to configure the existing 720-second process-group deadline.

Build snapshots and the one-second SSE stream include task telemetry, active
agent/verification elapsed time, project totals and per-agent metrics. Aggregation
happens after tenant/project filtering, behind the existing PostgreSQL RLS project
access check. The Build dashboard displays costs, latency, retry rates, failure
bars and budget progress. `PATCH /api/v1/projects/:id/build/tasks/:taskId/budget`
accepts `{ "revision": "<current revision>", "budget_cap_usd": 5 }` (or null)
and rejects stale revisions and closed or inaccessible tasks. Attempt output is
never included in the public telemetry payload.

After an agent succeeds, the independent verification gate must pass before
Git staging, commit and push. `pr_lifecycle.py` re-reads the task and requires a
successful, non-skipped verification for its current command. It creates a task
branch without resetting existing branches, commits implementation files, pushes
without force, and opens or reuses the branch's PR. PR title and body include the
roadmap description, requirements, acceptance criteria, verification gates and
linked issue. Reviewers come from `maintainers.json`'s `reviewers` array, falling
back to `authorized_approvers` only when `reviewers` is absent. Duplicates and the
PR author's own username are excluded from review requests. Missing or malformed
configuration stops publication with a recorded error.

The task stays `verified` while the PR is open. Every worker tick polls GitHub;
there is no wait loop for CI. Missing, pending, failed or unknown checks,
drafts, required reviews, conflicts and branch protection prevent merging.
Successful checks must match the published head SHA, branch and base. The merge
command uses `--match-head-commit` and never bypasses protections. A queued merge
is still pending: only GitHub's confirmed `MERGED` state records `completed`,
`merge_commit_sha` and `completed_at`. `commit_sha` remains the published task
commit. Closing an unmerged PR records `pr_status=closed` without completing the
task. GitHub closes linked issues through the PR's `Closes #...` reference.

Before each automated merge, the worker dispatches independent security and lint
reviewers concurrently over the PR diff. These are deterministic local checks for
credential leaks, unsafe execution, RLS bypasses, debugging statements and blocker
comments; CI remains responsible for the full project lint and test suites.
The default consensus policy requires two distinct approving agents, an approval
ratio of at least 0.66, and approval from every security and lint reviewer.
Critical and error findings block merging across all review roles. Missing roles,
duplicate identities, malformed results, exceptions and timeouts also block it.

`RuntimeConfig.review_timeout` bounds the whole review batch to 30 seconds;
`review_min_approvals` and `review_approval_threshold` configure its thresholds.
Direct lifecycle callers can supply `review_timeout` and a `review_policy` using
the keyword names from `evaluate_consensus_review_gate`. Policy comes from the
trusted caller, not task descriptions. Review callbacks must be read-only. Python
timeouts stop waiting for a callback; TypeScript callbacks receive an abort signal.
No review calls an implementation CLI or recursively runs the verification suite.

The gate refuses unavailable, empty, binary or truncated diffs. Diffs at or above
the command transport's 16,000-byte capture limit require manual review. It
rechecks the task, PR head and base commit, CI and GitHub review requirements after
evaluation, and uses `--match-head-commit` for the merge request. Review evidence
is stored in `consensus_review` with the reviewed head/base SHAs, findings, counts
and policy violations; `security_gate_status`, `review_status` and
`publication_error` explain a blocked merge. Credential snippets are redacted.
Blocked tasks stay verified and can be reviewed again on a later worker tick.

Failed checks on an open PR's verified head trigger self-healing. The worker
fetches failed Actions runs using the configured repository and exact commit SHA,
with explicit run IDs, at most three log reads and one shared 60-second deadline.
External checks or unavailable Actions logs fall back to check metadata. Analysis
normalizes Actions timestamps and ANSI colors, captures failing tests, compiler
errors, implicated files and Python/JavaScript stack traces, and stores bounded
`regression_analysis` with the PR number and source SHA.

An atomic roadmap update creates one approved `-FIX` task per failed head,
including `parent_task_id`, `source_commit_sha`, `target_branch`, verification
command, regression context and inherited tenant/project scope. Repair tasks take
priority over pending unrelated PRs. They check out the original failing branch,
revalidate the PR head, and receive instructions to reproduce the failure and add
a regression test. Successful local verification pushes the repair to the existing
PR. Only matching successful CI and a confirmed merge complete the repair and its
parent tasks. Cancellation or changed publication evidence blocks a repair. Failed
agent chains are retained for inspection without generating duplicate tasks;
a lineage can generate at most three repairs before recording
`self_healing_status=exhausted`. CI polling never dispatches an unbounded retry loop.

Git or GitHub failures preserve verification and `publication_error` for retry,
including a pushed branch or PR created before a timeout. Open PRs are reconciled
without another agent run or commit. Changing verification evidence or requirements
after publication blocks automatic merging until the publication is reconciled.
Publication uses a repository lock, and
updates merge into live roadmap records without overwriting cancellation or
changed requirements. The worker returns to the base branch after publication
and fast-forwards it before the next approved task. A pending PR is reconciled
before another feature task is dispatched; approved CI repairs take priority. It never force-resets local history.

`ROADMAP.json`, `ROADMAP.md` and ignored runtime logs stay local to avoid merging
stale scheduler state. `attempts`, failure tails and retry counts are saved via
the atomic roadmap store. The runtime writes local `ROADMAP.md` and
`logs/orchestrator.log`. Stale implementation `current_task_id` pointers still
require explicit recovery; verified publication can resume after a restart.

The worker also verifies `ready_for_verification` tasks without dispatching an
agent, then publishes them through the same PR lifecycle. Failure returns them
to `in_progress` for repair. Tasks verified with the standalone CLI are picked
up for publication on the next worker tick. To retry publication manually, run
`python3 pr_lifecycle.py <task_id>`; `python3 pr_lifecycle.py --scan-and-merge`
reconciles existing verified PRs. Both support `--project-root` and `--repo`.

Run `python3 verify_task.py <task_id>` to verify an `in_progress` or
`ready_for_verification` task directly. Use `--dry-run` to preview the command
without executing or changing any files, `--timeout 300` to set the hard deadline
in seconds, and `--project-root /path/to/checkout` to target another checkout.
The default deadline is 300 seconds; timeout kills the command's process group.
Both stdout and stderr are captured together. Each run appends to `verifications`
in `ROADMAP.json`, recording a UTC timestamp, exit code (`-1` on timeout, `-2` on
launch error), command, and the last 4,000 output characters. Success sets
`status` to `verified`; failure sets `in_progress`, increments `retry_count`,
appends the tail to `verification_failures`, and updates `last_error`. Other task
fields and concurrent edits are preserved. A command or lifecycle change during
execution cancels the result update. A repository lock prevents simultaneous
verifiers from executing commands against the same checkout.

For tasks without a command, standalone and ready-task verification record an
explicit skip note without changing status or retries. The worker waits for a
command to be supplied before revisiting a skipped task. Approved tasks still
require a command before agent dispatch. The verifier CLI exits 0 for success,
skip or dry-run, 1 for failure, cancellation or a busy verifier, and 2 for invalid
input.

This worker is separate from the tenant-facing Fastify API and PostgreSQL/RLS
sandbox dispatch below. Its prompts and shell verification commands are trusted
repository configuration. The regression suite runs through `npm test`, mocks
providers, and uses disposable local Git repositories without external pushes.

### Sandbox execution

`@software-factory/sandbox` supplies `DockerSandbox`, also re-exported by
`@software-factory/runtime`. Each running Execution receives an ephemeral,
non-root Node container with a read-only root filesystem, private namespaces,
no network, no host mounts, dropped capabilities and bounded writable tmpfs.
Source is JavaScript sent over stdin; it is never interpolated into a shell.
The worker host needs a Docker CLI, a Linux daemon with resource enforcement,
and a preloaded, operator-approved Node image pinned to its content digest.
Run the worker separately from the API; the submitted code receives no daemon
socket or application credentials.

```ts
import { DockerSandbox } from "@software-factory/sandbox";

const image = process.env["SANDBOX_IMAGE"];
if (!image) throw new Error("SANDBOX_IMAGE must be a preloaded digest-pinned image");
const sandbox = new DockerSandbox({
  image, // e.g. registry.example/approved-node@sha256:<64 hex characters>
  limits: { timeoutMs: 30_000, memoryMb: 128 },
});
// Pass sandbox to createQueueRuntime below. The trusted program resolver can
// set trust: "trusted" for local trusted tests only; omission means untrusted.
```

| Limit | Default | Absolute worker ceiling |
| --- | --- | --- |
| Wall-clock execution timeout | 30 seconds | 1 hour |
| Memory (swap disabled) | 128 MiB | 4096 MiB |
| CPUs | 1 | 4 |
| Process count | 64 | 512 |
| Each writable tmpfs mount | 16 MiB | 256 MiB |
| Combined stdout/stderr | 1 MiB | 16 MiB |

A program can reduce the operator's limits. Source is capped at 256 KiB of UTF-8.
Results carry tenant/execution IDs, a unique sandbox reference, separate stdout
and stderr, exit code, duration and a status (`succeeded`, `failed`, `timed_out`,
`output_limit`, `out_of_memory` or `cancelled`). Setup and transport failures
throw. Docker creation warnings fail closed before submitted code starts.
Timeout, output overflow and cancellation force container removal, including
descendant processes. Cleanup gets a separate bounded deadline;
unconfirmed cleanup raises `SandboxCleanupError` and the dispatch remains
unacknowledged for reconciliation. Success proposes `verifying`; independent
verification still owns completion.

[SF-ADR-004](docs/adrs/SF-ADR-004.md) requires independently validated strong
isolation for production untrusted code. Untrusted submissions fail closed
unless the operator configures `untrustedIsolation: { runtime, evidenceRef }`
for the exact image/runtime/deployment after its isolation/escape suite passes.
This configuration and the program's trust classification belong to the trusted
worker, never the user request or model output. A runtime name and evidence
reference record operator attestation; the adapter does not certify the runtime.
There is no fallback to executing submitted code on the host.

Unit tests exercise the Docker command protocol, actual CLI subprocess transport
and fenced worker integration without requiring Docker. Run the opt-in OCI
smoke tests against a disposable worker with a preloaded approved Node image:

```bash
SANDBOX_DOCKER_TESTS=1 \
SANDBOX_TEST_IMAGE='registry.example/approved-node@sha256:<digest>' \
npx vitest run packages/sandbox/src/__tests__/docker-sandbox.integration.test.ts
```

These smoke tests cover non-root identity, filesystem/network restrictions,
output capture, timeouts, memory limits and container removal. They do not
replace the independent production isolation/escape suite.

### Queue events and sandbox workers

Apply migration `20261015_004_event_delivery` with `npm run migrate:up` before
starting event workers. `createQueueRuntime` from `@software-factory/runtime`
connects the API's persisted `execution.created` event to queue admission, then
connects `queue.enqueued` to a fenced sandbox dispatch. Embed it in a worker
process with a trusted tenant identity, an RLS-enforcing `TenantDatabase`, a
configured `DockerSandbox`, and a trusted source resolver:

```ts
const worker = createQueueRuntime({
  identity,
  database,
  sandbox,
  workerId: "sandbox-worker-1",
  leaseMs: 60_000,
  resolveProgram: async (execution) => programs.load(execution.id),
});
await worker.runOnce(); // Call again from the worker's polling loop.
```

Each call expires lost execution leases and delivers a bounded batch of pending
outbox events (default 100 attempts, including failed deliveries). Outbox claims
commit before invoking consumers; sandbox execution never holds an open database
transaction. Deliveries are
ordered per execution, retried at least once, and fenced by expiring tokens.
Consumers registered with `worker.bus.subscribe` must make their effects
idempotent. Sandbox dispatch deduplicates through the durable queue: concurrent
or repeated deliveries cannot claim an execution twice. Lock contention keeps
the wakeup pending. After a worker crashes with a claimed execution, lease
expiry moves it to reconciliation rather than executing its code again.
Consumer failures leave that execution's events pending while the batch continues
with unrelated executions. `runOnce` reports failures after the batch; the polling
loop should catch and log them before its next attempt.

The history records queued, dispatched, running, and failed or verifying phases.
A successful sandbox enters `verifying`. A separate trusted verifier calls
`worker.history.finishVerification` with the expected version, the
`execution.verifying` event ID, a persisted evidence artifact ID, and its
`completed` or `failed` verdict. Completion requires valid consumed approvals
where approvals exist. This method records the verifier's decision; the caller
must perform the independent checks and produce the evidence. State, event and
outbox writes commit together. `worker.history.list` returns Event primitives;
`replayExecution` from `@software-factory/events` rebuilds their lifecycle phase
and rejects history gaps or invalid transitions. Dispatch is a history phase;
the authoritative Execution state vocabulary is unchanged.

Use a dedicated worker login with `NOSUPERUSER NOBYPASSRLS` and these grants
after migration (configure login credentials separately):

```sql
GRANT CONNECT ON DATABASE software_factory TO sf_worker;
GRANT USAGE ON SCHEMA public TO sf_worker;
GRANT SELECT, UPDATE ON works, executions TO sf_worker;
GRANT SELECT, INSERT ON events TO sf_worker;
GRANT SELECT, INSERT, UPDATE ON outbox, work_queue TO sf_worker;
GRANT SELECT, INSERT, DELETE ON worker_leases TO sf_worker;
GRANT SELECT ON artifacts, approvals TO sf_worker;
```

Agent workers use `createAgentRuntime` from `@software-factory/runtime` with the
same database, identity, worker ID, program resolver and lease settings. Supply
`contextBinding(execution)` to resolve the current base SHA, policy version and
model profile, and `runAgent(execution, program, session, signal)` for the bounded
agent loop. `session.checkpoint` contains the restored conversation and step;
call `await session.save(nextStep, context, stableCheckpointId)` after a finalized
observation and before the next step. Context has `schemaVersion: 1`, the binding
fields, `messages` (`role`, `content`, optional `toolCallId`), `summary` (string or
null), and JSON `metadata`. Persist concise observations and artifact references;
keep credentials and private reasoning out of context. Snapshots are limited to
1 MiB. A checkpoint ID can retry an uncertain save without duplicating history.

Migration `20261015_005_agent_checkpoints` adds immutable checkpoints and recovery
lineage with forced tenant RLS. Checkpoint writes require the current execution
version, worker, fence and unexpired database lease. The conversation, agent-run
pointer, checkpoint event and outbox entry commit together. Add these worker grants:

```sql
GRANT SELECT, INSERT ON agent_checkpoints, agent_recoveries TO sf_worker;
GRANT SELECT, INSERT, UPDATE ON agent_runs TO sf_worker;
GRANT INSERT ON executions TO sf_worker;
GRANT SELECT ON external_effects TO sf_worker;
```

After a crash, `runOnce()` expires the lease and preserves the attempt in
`needs_reconciliation`. A trusted recovery controller may call
`worker.checkpoints.recover(identity, { executionId, expectedVersion, baseSha,
policyVersion, modelProfile })`. For a proposal-only attempt with a checkpoint,
runnable Work, available unreserved budget, no approvals, and no external effects
other than rejected effects, this atomically creates a new queued Execution linked
to the original attempt. Repeated/concurrent recovery calls return the same new
execution ID. The new attempt restores the selected conversation and advances
past its saved step, with its own checkpoint sequence and lease. The old attempt
and audit events remain intact. Changed base/policy/model, approvals, and effects
that could be replayed require separate reconciliation; recovery refuses them.
Agent callbacks still run through the existing sandbox/cleanup and independent
verification contract and must honor cancellation.

Authenticated observability reads are `GET /api/v1/works/:id/executions` (all task
attempts with parent IDs and timestamps) and
`GET /api/v1/executions/:id/checkpoints` (checkpoint metadata). Both accept
`limit` (1–100, default 50) and `offset` (default 0), and use tenant-scoped reads.
Conversation content is available only through the trusted storage adapter.
Use the existing execution events endpoint for the full checkpoint/recovery audit.
Run `TEST_DATABASE_URL=... npm test` to include actual PostgreSQL persistence,
concurrency, RLS, crash recovery and rollback tests.

The worker never accepts its tenant identity or source trust classification from
event payloads. Existing sandbox isolation requirements still apply. Set
`TEST_DATABASE_URL` to run the disposable PostgreSQL event wiring suite, including
concurrent delivery, restart recovery, tenant isolation and transactional rollback.

Database migrations live in `infra/migrations/<timestamp>_<name>/`, with an
`up.sql` and `down.sql` in each directory. The initial migration's `up.sql`
matches `docs/45_STORAGE_SCHEMA.sql` byte for byte, including its Phase 1 RLS
and append-only enforcement annotations. `infra/migrations/001_initial_schema`
is a compatibility symlink to `20261015_001_initial_schema`; the runner only
discovers timestamp directories, so it executes the migration once.

Run `docker compose up -d --build --wait` to start PostgreSQL and the Fastify
API. The `web` service uses container name `software-factory_web`, publishes
port 3003, and waits for PostgreSQL to be healthy before starting. Its health
check calls `GET http://127.0.0.1:3003/health` inside the container using Node.js;
the same endpoint is available at `http://localhost:3003/health` on the host.
The image runs the existing TypeScript entry point with `tsx` without a watcher.

The API connects to `postgres:5432` on the Compose network, independently of
`POSTGRES_PORT`. Set `API_DATABASE_URL` to override that connection for the web
service. The default `sf` role is the development database administrator;
tenant API operations require a non-superuser role without `BYPASSRLS`, which
the storage layer enforces. Apply migrations separately using the commands
below before making database-backed requests. Validate the Compose definition
with `docker compose config --quiet`.

Start PostgreSQL 16 with `docker compose up -d --wait postgres`, then run:

```sh
export DATABASE_URL=postgres://sf:sf_dev_pw@127.0.0.1:5432/software_factory
npm run migrate:up
npm run migrate:verify
npm run migrate:down
```

`DATABASE_URL` defaults to the local Compose database above. Export it in the
shell; the runner does not load `.env` files. `migrate:up` applies all pending
migrations and `migrate:down` rolls back the last applied migration. Add
`-- --dry` to preview either command without retaining database changes. The
Node.js runner uses `pg`, a transaction and an advisory lock, and records
checksums in `_migrations` to reject changed or missing applied migrations.
`migrate:verify` checks that every tenant table has RLS enabled and forced,
with a tenant isolation policy covering reads and writes, including the outbox
and work queue.
Rollback drops the sixteen domain tables in reverse dependency order, along
with their constraints and indexes. It preserves `_migrations` and the shared
`pgcrypto` extension. Add a new timestamp directory for future schema changes
rather than editing an applied migration.

Set `TEST_DATABASE_URL` to a PostgreSQL 16+ connection to enable the live
storage tests during `npm test`. Use the development/CI database administrator;
the tests create and delete disposable databases and roles. They exercise both
npm migration commands, constraints, concurrency, rollback, and tenant isolation
on all 17 tenant tables, including access as a table owner and pooled connection
reuse. Without this variable, the live tests are skipped.

Run `npm run db:seed` after `migrate:up` to create a development tenant. The seed
uses a fixed tenant ID and preserves existing rows when repeated.

Run `npm run test:e2e` for the Phase 0 integration smoke test in
`tests/e2e/phase0-smoke.test.ts`. It requires Docker Compose v2 and an accessible
Docker daemon; missing prerequisites fail with a component-specific message.
This suite runs separately from `npm test`, which does not require Docker.
It starts the repository's Compose stack under a unique project name with a
temporary PostgreSQL port, waits for the database health check, runs migrations
and seeds twice to verify repeatability, queries the seeded tenants, and starts
the Fastify placeholder on a temporary port to check `GET /health` over HTTP.
It uses its own database regardless of `DATABASE_URL` and removes its containers,
network, and volumes after success or failure. The default development Compose
port remains 5432; set `POSTGRES_PORT` to choose a different host port.

`.github/workflows/ci.yml` runs on pushes to every branch and pull requests to
`main`, skipping changes confined to `docs/**`. It installs Node LTS and locked
npm dependencies with an npm cache, then runs strict ESLint, the complete
TypeScript project build, and unit tests. It starts PostgreSQL 16 through the
development Compose configuration, runs `migrate:up`, checks all sixteen domain
tables and `_migrations` with `migrate:verify`, and runs `migrate:down`. The live
migration suite then checks constraints, concurrency, failure recovery, and
rollback against a disposable database. Finally, `test:e2e` verifies the Phase 0
skeleton end-to-end. Logs are printed on failure and Compose volumes are removed
on exit, including a fallback cleanup for interrupted smoke tests. The validation
job has a nine-minute timeout.

`.github/workflows/ci-notify.yml` comments on the PR or commit with the failed
run's log link, including when CI times out. It uses a separate `workflow_run`
notification so fork PRs can receive comments without granting write access to
the code under test. This notification workflow must be on the default branch
to receive events; it never checks out PR code or downloads run artifacts.

Releases use `.github/workflows/release.yml`. Push a version tag such as
`v0.1.1` to run the same full CI workflow against that exact commit before
creating a GitHub Release. The release job alone has `contents: write` access.
Version tags must use `vMAJOR.MINOR.PATCH`, optionally with a prerelease or build
suffix; prerelease versions are marked as prereleases on GitHub.

After this workflow reaches `main` and main CI succeeds, it automatically
creates the initial placeholder `v0.1.0` tag and release at the validated
commit. The bootstrap skips an existing tag and waits for newer main commits
to pass CI. It publishes directly after validation because tags created with
`GITHUB_TOKEN` do not trigger another workflow. Later main pushes do not create
additional versions. Existing releases are preserved when a workflow is rerun.

Write Conventional Commits such as `feat(api): add project search` or
`fix(storage): preserve tenant isolation`. `.versionrc` controls changelog
sections, hidden commit types, and GitHub links. Release notes are generated
from reachable commit messages since the previous version tag (or all history
for the first release), with **What's new**, **Breaking changes**, and
**Migration notes** sections. Mark breaking changes with `!` or a
`BREAKING CHANGE:` / `BREAKING-CHANGE:` footer, including for hidden commit
types. Add upgrade instructions in a `MIGRATION:` or `MIGRATION NOTES:` footer;
multiline footer text is retained. For example:

```text
feat(api)!: rename project status

BREAKING CHANGE: The state field is now named status.
MIGRATION: Update API clients to read and write status.
```

Preview notes locally without creating a tag or release:

```sh
npm run release:notes -- v0.1.0 HEAD
```

To publish a subsequent version, tag the intended commit and push the tag:

```sh
git tag -a v0.1.1 -m "Release v0.1.1"
git push origin v0.1.1
```

### Ask workbench

Run `npm run dev --workspace @software-factory/workbench` and open the displayed
URL with `?project=<project UUID>`, or use the project form. The Vite dev server
proxies `/api` to the Fastify API on port 3000. The host must configure the API's
existing trusted `authenticate` callback (for example, using a verified session
cookie); the default API fails closed. Client tenant/actor headers do not grant
access. `npm run build --workspace @software-factory/workbench` produces the UI
in `apps/workbench/build` for serving alongside the API.

Describe up to 12 requirements in prose, bullets or separate lines (10,000
characters maximum). **Generate plan** makes a read-only proposal with design,
implementation and verification tasks, assigned agents, verification gates and
assumptions. Planning uses a deterministic local parser, so no model API key or
provider quota is required. This is a scope draft; review the generated tasks
before acceptance.

**Accept plan and save pending tasks** explicitly appends tasks to the repository's
`ROADMAP.json`. These tasks have `status: pending`; the orchestrator only dispatches
separately approved tasks. The API checks the actor and project in a PostgreSQL
tenant transaction with RLS before accepting. It uses Python 3's `fcntl` lock,
shared with the existing roadmap writers, and atomic file replacement. Durable
intake receipts protect retries and concurrent requests, including after a lost
response. The API process needs write access to the roadmap and its directory.

The authenticated endpoints are `POST /api/v1/projects/:id/ask` with
`{ "description": "Build a dashboard" }`, and
`POST /api/v1/projects/:id/ask/tasks` with the same description plus
`"accepted": true` and an `Idempotency-Key` header (8–128 characters). Reuse the
same key only when retrying the same acceptance. Commands and agent assignments
are generated by trusted code; prompt text cannot override them. Accepted tasks
retain tenant, project and actor metadata. `AppOptions.askRoadmap` allows a host
to supply an alternative trusted store.

### Build dashboard

In the workbench, select **Build**, or open `?project=<project UUID>&mode=build`.
The dashboard shows task status, completed-task progress, the active task,
assigned agents, retry counts, linked GitHub issue numbers, and commit IDs.
An empty project directs you back to Ask. Pending tasks have **Approve task**;
failed tasks have **Approve retry**. Approval authorizes the existing orchestrator
to dispatch; it does not start a second worker. The repository orchestrator must
be running for approved tasks to execute.

The authenticated routes are:

- `GET /api/v1/projects/:id/build` — current tasks and recent activity.
- `GET /api/v1/projects/:id/build/stream` — server-sent `snapshot` events, updated
  every second. Reconnect replaces the snapshot, including its bounded log tail,
  so repeated events do not duplicate log entries.
- `POST /api/v1/projects/:id/build/tasks/:taskId/approve` — body
  `{ "revision": "<task revision from snapshot>" }`. A changed or closed task
  returns 409. Retries by the same actor with the same revision are safe,
  including after dispatch. Decisions persist actor, timestamp and revision.

Every request checks the actor and project through the existing PostgreSQL/RLS
transaction. Streams repeat those checks each tick and emit `unavailable` before
closing if access is revoked or the source fails. The UI shows disconnects,
reconnects automatically after transport interruptions, and provides a manual
refresh. Approval controls stay disabled while updates are disconnected.

The roadmap remains the scheduler's source of truth. Only tasks with matching
trusted `tenant_id` and `project_id` are visible; unbound legacy repository tasks
are excluded. Ask creates these bindings. A trusted GitHub intake adapter must
also bind its issue tasks before exposing them in a tenant project; issue body
text must never establish identity. Existing issue approval/closure handlers and
the orchestrator update the same tasks. Issue closure remains terminal, including
against stale approval requests and stale bot saves. Approving one dashboard task
does not approve its sibling tasks through a GitHub issue label.

Task-scoped activity is appended to `logs/build.jsonl` by the orchestrator,
GitHub webhook and dashboard. The API reads a bounded 256 KiB tail and returns
at most 200 matching entries. It exposes lifecycle messages rather than unscoped
repository logs or agent conversations. Restart those Python services after
updating to enable the new feed. Entries older than the rolling tail are omitted;
this feed is not a full log archive. No provider API key is needed for the UI.
Hosts using another scheduler can supply the trusted `AppOptions.buildRoadmap`
adapter. File adapters require Python 3 and access to the shared roadmap and log
directory, as the Ask adapter does.
