# 🗺️ Live Development Roadmap & Task Tracker

> **Last Updated:** `2026-10-15 10:56:41 UTC`  
> **Supervisor:** Autonomous Tri-Agent Orchestra (`Claude Code` ↔ `OpenAI Codex` ↔ `Google Antigravity`)  
> **Progress:** `[░░░░░░░░░░░░░░░░░░░░]` **0 / 26** tasks completed (**0%**)

---

## ⚡️ Currently In Progress

### 🟡 `T-ISSUE-2` — Issue #2: Monorepo skeleton: TypeScript strict config and package structure
- **Phase:** Community & Issues
- **Assigned Agent:** `CLAUDE`
- **Description:** ## Description
Scaffold the monorepo skeleton per `docs/13_REPOSITORY_LAYOUT_v1.md` and `docs/35_BUILD_PLAN_AND_ACCEPTANCE.md`. Use npm workspaces (or pnpm workspaces) for package management. Enforce TypeScript strict mode across all packages.

## Directory structure
```
software-factory/
  apps/
    api/          # public API + auth (Phase 1+, scaffold now)
    workbench/    # UI (Phase 4+, scaffold now)
  packages/
    factory-core/ # six primitive domain model
    runtime/      # worker runtime (Phase 3+, scaffold now)
    flow/         # flow engine (Phase 2+, scaffold now)
    events/       # event contracts (Phase 1+, scaffold now)
    storage/      # DB access layer (Phase 1+, scaffold now)
  infra/
    migrations/   # SQL migrations (this phase)
  tests/
    contract/     # contract tests (Phase 1+, scaffold now)
    e2e/          # e2e tests (Phase 4+, scaffold now)
  docs/
```

## Acceptance Criteria
- [ ] Root `package.json` with workspaces config pointing to `apps/*` and `packages/*`
- [ ] Each package dir has a `package.json` with `"private": true` and `"type": "module"`
- [ ] Root `tsconfig.json` with `strict: true`, `noUncheckedIndexedAccess: true`, `exactOptionalPropertyTypes: true`, `moduleResolution: "bundler"`, target `ES2022`
- [ ] Each package has its own `tsconfig.json` extending root
- [ ] `apps/api` has a minimal `src/index.ts` that exports a noop
- [ ] `packages/factory-core` has `src/index.ts` re-exporting domain types placeholder
- [ ] `docs/` dir kept pristine for spec documents
- [ ] Build succeeds: `npx tsc --noEmit` exits 0 across all packages

Reference: Closes #2
- **Quality Gate Command:** `cd /root/projects/software-factory && npm run typecheck && npm test`

---

## 📋 Upcoming Queue (Next in Priority)

| Priority | Task ID | Title | Assigned Agent | Phase |
|:---:|:---|:---|:---:|:---|
| **#1** | `T-ISSUE-3-1` | Issue #3 (Part 1/3): Create shared TypeScript configuration package with strict settings | `CLAUDE` | Community & Issues |
| **#2** | `T-ISSUE-3-2` | Issue #3 (Part 2/3): Set up shared Prettier and ESLint configs with TypeScript strict rules | `CLAUDE` | Community & Issues |
| **#3** | `T-ISSUE-3-3` | Issue #3 (Part 3/3): Set up tsup/tx for dev mode and verify type error detection | `CLAUDE` | Community & Issues |
| **#4** | `T-ISSUE-5` | Issue #5: First database migration from storage schema (docs/45_STORAGE_SCHEMA.sql) | `CLAUDE` | Community & Issues |
| **#5** | `T-ISSUE-7-1` | Issue #7 (Part 1/3): Create CI workflow file with setup, lint, and typecheck stages | `CLAUDE` | Community & Issues |
| **#6** | `T-ISSUE-7-2` | Issue #7 (Part 2/3): Add unit test and Docker-based migration verify stages | `CLAUDE` | Community & Issues |
| **#7** | `T-ISSUE-7-3` | Issue #7 (Part 3/3): Add PR/commit notification on failure using GitHub commit status | `CLAUDE` | Community & Issues |
| **#8** | `T-ISSUE-8-1` | Issue #8 (Part 1/3): Create release workflow with CI gate and GitHub Release generation | `CLAUDE` | Community & Issues |
| **#9** | `T-ISSUE-8-2` | Issue #8 (Part 2/3): Add changelog configuration and versionrc | `CLAUDE` | Community & Issues |
| **#10** | `T-ISSUE-8-3` | Issue #8 (Part 3/3): Add CI status badge to README and draft initial v0.1.0 release notes | `CLAUDE` | Community & Issues |
| **#11** | `T-ISSUE-9` | Issue #9: Package factory-core: domain model primitive types and Zod schemas | `CLAUDE` | Community & Issues |
| **#12** | `T-ISSUE-11` | Issue #11: Phase 0 integration smoke test: end-to-end skeleton verification | `CLAUDE` | Community & Issues |
| **#13** | `T-001` | Fastify health + CRUD routes with RLS-ready PostgreSQL integration | `CLAUDE` | Phase 1: Core APIs + RLS |
| **#14** | `T-002` | OpenAPI spec alignment and API contract tests | `CODEX` | Phase 1: Core APIs + RLS |
| **#15** | `T-003` | Docker Compose app service integration and health-check wiring | `CLAUDE` | Phase 1: Core APIs + RLS |
| **#16** | `T-004` | Distributed work queue with PostgreSQL-backed persistence | `CODEX` | Phase 2: Queue + Sandbox |
| **#17** | `T-005` | Sandbox execution environment for untrusted code | `CLAUDE` | Phase 2: Queue + Sandbox |
| **#18** | `T-006` | Event system wiring: queue events to sandbox dispatch | `CODEX` | Phase 2: Queue + Sandbox |
| **#19** | `T-007` | Agent runtime loop with task dispatch and failover chain | `CLAUDE` | Phase 3: Agent Runtime |
| **#20** | `T-008` | Agent context persistence and checkpoint recovery | `CODEX` | Phase 3: Agent Runtime |
| **#21** | `T-009` | Ask interface: natural-language intake and task generation | `CLAUDE` | Phase 4: Ask/Build UI |
| **#22** | `T-010` | Build dashboard: live task progress, logs, and approval workflow | `CODEX` | Phase 4: Ask/Build UI |

---

## 🟢 Completed Deliverables
