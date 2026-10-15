> **v6.1:** Legacy ADR numbers in this document use the `LEGACY36-` prefix to avoid collision with document 14. The MVP/future-phase exclusion is superseded by 37. See 38.

# Software Factory — Architecture Decisions & Traceability

**Status:** historical decision record; binding defaults in 43

## Accepted decisions
- **LEGACY36-ADR-001:** Product name is Software Factory; do not expose Devin as product brand.
- **LEGACY36-ADR-002:** Keep six Factory primitives unchanged; agent internals are projections and adapter implementations.
- **LEGACY36-ADR-003:** Agent Runtime is replaceable; Factory owns Execution lifecycle.
- **LEGACY36-ADR-004:** Worker isolation and tool authorization are mandatory for autonomous coding.
- **LEGACY36-ADR-005:** Event-driven audit and artifact references are authoritative for observability.
- **LEGACY36-ADR-006:** Protected writes, secrets and policy changes require external authorization.
- **LEGACY36-ADR-007:** Single-agent vertical slice before subagent orchestration.

## Open decisions before production
- **OD-01:** Select existing backend/frontend languages and queue based on team constraints.
- **OD-02:** Choose container versus microVM isolation by threat model.
- **OD-03:** Specify hosting, regional data residency, tenant encryption and retention.
- **OD-04:** Decide model providers, pricing, fallback and evaluation benchmark.
- **OD-05:** Decide Git provider integration and merge governance.
- **OD-06:** Set SLOs, maximum run duration and per-tenant quotas.

## Capability → source → integrated specification
| Capability | Original source | New authoritative location |
|---|---|---|
| Core coordination | Factory 02, 06, 07 | 31, 33 |
| UX and Ask/Build | Factory 19–30 | Factory 19–30 + 31, 35 |
| Worker and isolation | Factory 05, 16 + agent source 04 | 34 |
| Agent loop and context | agent source 01, 02 | 32 |
| Tools and MCP | agent source 03 | 32, 34 |
| Client/ACP | agent source 05 | mandatory full-build capability |
| Reliability and audit | Factory 09, 15, 17 | 31, 33, 35 |

## Conflict resolution
When older files describe broad future capabilities without precise implementation details, use 37–48 for the full build. Treat original agent specs as design inputs rather than verified descriptions of any proprietary implementation. Never interpret example file paths or internals as required vendor-compatible APIs.
