# SF-ADR-005 — OIDC Login, Server-Resolved Tenant, Project RBAC, Service-to-Service mTLS

- **Status:** Accepted
- **Date:** Phase 0 baseline
- **Source of record:** docs/43_BINDING_ADRS_AND_DECISION_POLICY.md (binding, v6.2)

## Context

Identity and tenancy must not be spoofable from the client. A single logical tenant may serve local installs, but tenant_id is mandatory, derived server-side and enforced for every record and artifact (doc 38). Protected writes, secrets and policy changes require external authorization (LEGACY36-ADR-006). Services must authenticate each other as well as users.

## Decision

Use **OIDC login** for users, resolve the **tenant server-side**, enforce **project RBAC**, and require **service-to-service mTLS**.

**Invariant (normative):** no client-selected tenant or actor identity.

## Consequences

- A client cannot choose its tenant or claim an actor identity; both are derived from verified server-side state.
- RBAC is checked per project for every protected operation; policy service is authoritative and tool/model output is untrusted.
- All internal service calls authenticate via mTLS; no unauthenticated internal surface exists.
- OIDC provider configuration is a deploy-time operator input; missing credentials block deployment rather than being bypassed.
- Multi-tenant security semantics are mandatory even when only one tenant exists locally.