# SF-ADR-006 — Vendor-Neutral Adapters with Typed Capabilities and Mock Test Servers

- **Status:** Accepted
- **Date:** Phase 0 baseline
- **Source of record:** docs/43_BINDING_ADRS_AND_DECISION_POLICY.md (binding, v6.2)

## Context

The factory must not be captured by any single model, Git, MCP or ACP vendor. Legacy decisions require vendor-neutral model/Git adapters (doc 38) and treat original agent specs as design inputs rather than verified vendor APIs. Providers are configured via a secrets broker, not prompts, and real provider behavior cannot be assumed before credentials exist.

## Decision

Implement **vendor-neutral model/Git/MCP/ACP adapters** exposing **typed capabilities**, and provide **mock test servers** for each adapter family.

**Invariant (normative):** real provider is BLOCKED until credentials and conformance tests are supplied.

## Consequences

- Code depends on capability interfaces, not vendor SDKs; adding a provider is an adapter, not a rearchitecture.
- Mock test servers exercise the full stack in CI without external connectivity.
- A real provider cannot be called until (a) credentials are configured and (b) conformance tests against that provider pass — the adapter stays blocked otherwise.
- Configured credentials arrive via the secrets broker; nothing is injected from prompts, logs or artifacts.
- This preserves the "no default live production deployment" posture.