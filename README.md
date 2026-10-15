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
tasks also require authenticated `gh` access. Use a dedicated checkout with an
`origin` remote and Git author identity configured: successful runs stage all
checkout changes and push to `main` without force.

Run `python3 orchestrator.py --once` to process at most one approved task, or use
`--project-root`, `--repo`, `--remote` and `--branch` to target another checkout.
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

After an agent succeeds, the independent verification gate must pass before
Git staging, commit and push. Any Git failure stops publication and leaves the
task failed; push rejection preserves the local commit. Completion and its
`commit_sha` are recorded in the local roadmap only after push succeeds, so this
final bookkeeping is saved after the implementation checkpoint. This checkout's
roadmap is the live scheduler state. `attempts`, failure tails and retry counts
are persisted after each attempt using the shared atomic roadmap store, while
concurrent edits and issue closures are preserved. The runtime writes local
`ROADMAP.md` and `logs/orchestrator.log`. It does not automatically reclaim a
stale `current_task_id` after a crash; inspect that task before approving it again
and clearing the pointer.

This worker is separate from the tenant-facing Fastify API and PostgreSQL/RLS
sandbox dispatch below. Its prompts and shell verification commands are trusted
repository configuration. The regression suite runs through `npm test`, mocks
providers, and uses disposable local Git repositories without external pushes.

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
