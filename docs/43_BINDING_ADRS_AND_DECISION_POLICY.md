# Binding architecture decisions — v6.2
All items below are normative defaults. An implementer may change one only with an explicit replacement ADR, contract updates and equivalent security tests. Missing credentials or hosting settings are deploy-time blockers, not permission to omit functionality.

| ID | Decision | Invariant |
|---|---|---|
| SF-ADR-001 | TypeScript strict for web, API, scheduler, workers and contracts; Node LTS, React UI | One shared generated contract package |
| SF-ADR-002 | PostgreSQL transactional state, outbox, durable jobs and leases | Serializable or explicit CAS for contested transitions; no in-memory source of truth |
| SF-ADR-003 | S3-compatible encrypted content-addressed object storage | tenant-bound metadata and checksum verification |
| SF-ADR-004 | OCI non-root sandbox for local trusted tests; production untrusted code requires independently validated strong isolation (microVM or equivalent) | fail closed until isolation suite passes; no Docker socket, host mounts or metadata access |
| SF-ADR-005 | OIDC login, server-resolved tenant, project RBAC, service-to-service mTLS | no client-selected tenant or actor identity |
| SF-ADR-006 | Vendor-neutral model/Git/MCP/ACP adapters, typed capabilities and mock test servers | real provider is BLOCKED until credentials and conformance tests are supplied |
| SF-ADR-007 | Execution and AgentRun lifecycles separate, event + outbox atomically committed | no completion before approvals and verification |
| SF-ADR-008 | Scoped one-use approval bound to canonical action digest | approval invalid on any bound-field change |
| SF-ADR-009 | Durable intent log and reconcile-before-retry for remote side effects | unknown outcome never blindly retried |
| SF-ADR-010 | Parent-child runs with budget escrow and isolated worktrees | no implicit merge or budget multiplication |
| SF-ADR-011 | Self-modification requires independent reviewer and rollback proof | cannot alter own approval policy |
| SF-ADR-012 | API-first OpenAPI 3.1 + JSON Schema 2020-12; additive v1 changes only | CI validates request and response |

## Deployment decisions deliberately configurable
Production domain, hosting provider, region, model accounts, Git accounts, encryption key provider, retention period and numeric SLO are operator inputs. No live external connection or production-ready assertion until configured and verified. Defaults for local harness: 30-day non-audit artifact retention, 15-minute access-token TTL, 60-second worker lease with 20-second heartbeat, 1-hour execution wall clock, USD 15 execution cap; override only through validated configuration. These are engineering defaults, not guarantees of suitability in all jurisdictions.

## Historical ADR handling
All identifiers in document 14 are LEGACY14-ADR-###; all identifiers in 36 are LEGACY36-ADR-###. Only SF-ADR-### is binding. CI must reject unqualified ADR-### references in newly authored specifications.
