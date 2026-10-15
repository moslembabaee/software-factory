# SF-ADR-004 — OCI Non-Root Sandbox for Local Trusted Tests; Independently Validated Strong Isolation for Production Untrusted Code

- **Status:** Accepted
- **Date:** Phase 0 baseline
- **Source of record:** docs/43_BINDING_ADRS_AND_DECISION_POLICY.md (binding, v6.2)

## Context

Agents are shell-capable; worktrees alone are not a security boundary (LEGACY14-ADR-024). Local development runs trusted code, while production executes untrusted third-party code where container isolation may be insufficient for the threat model. Legacy decision LEGACY36-OD-02 left container vs microVM open; this ADR resolves it by context.

## Decision

Local trusted tests run in an **OCI non-root sandbox**. Production untrusted code requires **independently validated strong isolation (microVM or equivalent)**.

**Invariant (normative):** fail closed until isolation suite passes; no Docker socket, host mounts or metadata access.

## Consequences

- Until the isolation/escape test suite passes, untrusted execution is disabled — fail closed, never fail open.
- The sandbox denies the Docker socket, host path mounts and cloud metadata endpoint access by default; network egress is denied by default.
- Automated escape/exfiltration tests must pass before production untrusted runs are enabled; if validation fails, untrusted runs stay disabled.
- Local development remains cheap and fast (OCI container) while production carries the stronger boundary.
- The worker runs as non-root inside the sandbox; least-privilege credentials are injected only into the scoped tool process.