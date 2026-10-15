# 🗺️ Live Development Roadmap & Task Tracker

> **Last Updated:** `2026-10-15 12:24:56 UTC`  
> **Supervisor:** Autonomous Tri-Agent Orchestra (`Claude Code` ↔ `OpenAI Codex` ↔ `Google Antigravity`)  
> **Progress:** `[████░░░░░░░░░░░░░░░░]` **7 / 32** tasks completed (**21%**)

---

## ⚡️ Currently In Progress

### 🟡 `T-ISSUE-8` — Issue #8: Release pipeline: version tagging and changelog generation
- **Phase:** Community & Issues
- **Assigned Agent:** `CODEX`
- **Description:** ## Description
Set up a release workflow that creates version tags and generates changelogs based on conventional commits. Initial release tag: `v0.1.0`.

## Deliverables
- `.github/workflows/release.yml` triggered by pushing a tag matching `v*`
- Release job that runs full CI first, then creates a GitHub Release
- Conventional Commits changelog generation (automatic from commit messages)
- Release notes include: what's new, breaking changes, migration notes
- Create an initial placeholder `v0.1.0` release after main CI passes

## Acceptance Criteria
- [ ] Pushing `v0.1.0` tag triggers the workflow
- [ ] Full CI passes before release is created
- [ ] GitHub Release is created with auto-generated release notes
- [ ] `.versionrc` or changelog config exists at repo root
- [ ] README badge shows CI status

Reference: Closes #8
- **Quality Gate Command:** `cd /root/projects/software-factory && npm run typecheck && npm test`

---

## 📋 Upcoming Queue (Next in Priority)

| Priority | Task ID | Title | Assigned Agent | Phase |
|:---:|:---|:---|:---:|:---|
| **#1** | `T-ISSUE-11` | Issue #11: Phase 0 integration smoke test: end-to-end skeleton verification | `CODEX` | Community & Issues |
| **#2** | `T-001` | Fastify health + CRUD routes with RLS-ready PostgreSQL integration | `CODEX` | Phase 1: Core APIs + RLS |
| **#3** | `T-002` | OpenAPI spec alignment and API contract tests | `CODEX` | Phase 1: Core APIs + RLS |
| **#4** | `T-003` | Docker Compose app service integration and health-check wiring | `CODEX` | Phase 1: Core APIs + RLS |
| **#5** | `T-004` | Distributed work queue with PostgreSQL-backed persistence | `CODEX` | Phase 2: Queue + Sandbox |
| **#6** | `T-005` | Sandbox execution environment for untrusted code | `CODEX` | Phase 2: Queue + Sandbox |
| **#7** | `T-006` | Event system wiring: queue events to sandbox dispatch | `CODEX` | Phase 2: Queue + Sandbox |
| **#8** | `T-007` | Agent runtime loop with task dispatch and failover chain | `CODEX` | Phase 3: Agent Runtime |
| **#9** | `T-008` | Agent context persistence and checkpoint recovery | `CODEX` | Phase 3: Agent Runtime |
| **#10** | `T-009` | Ask interface: natural-language intake and task generation | `CODEX` | Phase 4: Ask/Build UI |
| **#11** | `T-010` | Build dashboard: live task progress, logs, and approval workflow | `CODEX` | Phase 4: Ask/Build UI |
| **#12** | `T-EVOLVE-1792061687-1` | Add a task verification executor that runs verification_cmd and updates roadmap status | `CODEX` | Continuous Polish & Evolution |
| **#13** | `T-EVOLVE-1792061687-2` | Add retry-with-backoff and stale-task recovery to the orchestrator | `CODEX` | Continuous Polish & Evolution |
| **#14** | `T-EVOLVE-1792061687-3` | Add two-way GitHub issue <-> roadmap task sync | `CODEX` | Continuous Polish & Evolution |
| **#15** | `T-ISSUE-2` | Issue #2: Monorepo skeleton: TypeScript strict config and package structure | `CODEX` | Community & Issues |
| **#16** | `T-ISSUE-3-1` | Issue #3 (Part 1/3): Create shared TypeScript configuration package with strict settings | `CODEX` | Community & Issues |
| **#17** | `T-ISSUE-3-2` | Issue #3 (Part 2/3): Set up shared Prettier and ESLint configs with TypeScript strict rules | `CODEX` | Community & Issues |
| **#18** | `T-ISSUE-3-3` | Issue #3 (Part 3/3): Set up tsup/tx for dev mode and verify type error detection | `CODEX` | Community & Issues |
| **#19** | `T-ISSUE-7-1` | Issue #7 (Part 1/3): Create CI workflow file with setup, lint, and typecheck stages | `CODEX` | Community & Issues |
| **#20** | `T-ISSUE-7-2` | Issue #7 (Part 2/3): Add unit test and Docker-based migration verify stages | `CODEX` | Community & Issues |
| **#21** | `T-ISSUE-7-3` | Issue #7 (Part 3/3): Add PR/commit notification on failure using GitHub commit status | `CODEX` | Community & Issues |
| **#22** | `T-ISSUE-8-1` | Issue #8 (Part 1/3): Create release workflow with CI gate and GitHub Release generation | `CODEX` | Community & Issues |
| **#23** | `T-ISSUE-8-2` | Issue #8 (Part 2/3): Add changelog configuration and versionrc | `CODEX` | Community & Issues |
| **#24** | `T-ISSUE-8-3` | Issue #8 (Part 3/3): Add CI status badge to README and draft initial v0.1.0 release notes | `CODEX` | Community & Issues |

---

## 🟢 Completed Deliverables

| Status | Task ID | Title | Agent | Phase | Completed At |
|:---:|:---|:---|:---:|:---|:---|
| 🟢 Done | `T-ISSUE-9` | Issue #9: Package factory-core: domain model primitive types and Zod schemas | `CODEX` | Community & Issues | `2026-10-15 12:24:56` |
| 🟢 Done | `T-ISSUE-7` | Issue #7: CI pipeline: lint, typecheck, test, and migration verify | `CODEX` | Community & Issues | `2026-10-15 12:15:27` |
| 🟢 Done | `T-ISSUE-5` | Issue #5: First database migration from storage schema (docs/45_STORAGE_SCHEMA.sql) | `CODEX` | Community & Issues | `2026-10-15 12:05:06` |
| 🟢 Done | `T-ISSUE-3` | Issue #3: TypeScript strict shared config and compiler helpers | `CODEX` | Community & Issues | `2026-10-15 11:58:27` |
| 🟢 Done | `T-ISSUE-2-3` | Issue #2 (Part 3/3): Placeholder source files and root scripts | `CODEX` | Community & Issues | `2026-10-15 11:29:09` |
| 🟢 Done | `T-ISSUE-2-2` | Issue #2 (Part 2/3): Root and per-package tsconfig with strict mode | `CODEX` | Community & Issues | `2026-10-15 11:21:59` |
| 🟢 Done | `T-ISSUE-2-1` | Issue #2 (Part 1/3): Root monorepo config and directory scaffold | `CODEX` | Community & Issues | `2026-10-15 11:14:52` |
