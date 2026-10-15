# Software Factory full-build pack v6.3

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
Rollback drops the sixteen domain tables in reverse dependency order, along
with their constraints and indexes. It preserves `_migrations` and the shared
`pgcrypto` extension. Add a new timestamp directory for future schema changes
rather than editing an applied migration.

Set `TEST_DATABASE_URL` to a PostgreSQL 16+ connection to enable the live
migration tests during `npm test`. Its role must be able to create databases;
the tests create and delete a disposable database and exercise both npm
commands, constraints, concurrency, and rollback. Without this variable, the
live tests are skipped.

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
