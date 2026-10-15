# SF-ADR-012 — API-First OpenAPI 3.1 + JSON Schema 2020-12; Additive v1 Changes Only

- **Status:** Accepted
- **Date:** Phase 0 baseline
- **Source of record:** docs/43_BINDING_ADRS_AND_DECISION_POLICY.md (binding, v6.2)

## Context

The API is the primary contract surface: the workbench is a coordination UI, not a replacement for other control surfaces (LEGACY14-ADR-007/008), and equivalent commands may come from the API. API-first development requires one normative specification that drives the shared generated contract package (SF-ADR-001) and that CI can validate mechanically on both request and response paths.

## Decision

Specify the API with **OpenAPI 3.1** and **JSON Schema 2020-12**, API-first; while v1 is live, only **additive changes** are permitted.

**Invariant (normative):** CI validates request and response.

## Consequences

- The OpenAPI/JSON Schema documents are the source of truth; generated contracts derive from them (SF-ADR-001), so clients and server cannot drift.
- CI validates both requests and responses against the schemas, catching contract violations on either side of the wire.
- Breaking v1 changes are forbidden; evolution is additive (new endpoints, new optional fields), keeping existing consumers stable.
- A breaking change requires a new major version with its own decision record.
- The API remains a full first-class control surface alongside Workbench, Git, Jira and Slack equivalents.