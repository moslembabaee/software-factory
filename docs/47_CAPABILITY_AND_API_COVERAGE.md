# Full-build capability and endpoint inventory — normative
No row is optional. For each row implement UI, server handler, schema, persistence, policy, observability, tests and operator docs as applicable. The core OpenAPI reference in 46 is **partial**; it must be expanded to include all endpoints below before the implementation is accepted. A row is not evidence of implementation.

| Capability | Source documents | Required API family / event or adapter | Required proof |
|---|---|---|---|
| Work, actors, executions, events, references, relations | 02,06,07,31,33 | /works, /executions, /events, /references, /relations | tenant isolation, CAS, dedup |
| Project and workspace | 01,19,20,26 | /projects, /workspaces, /files | RBAC, path guards |
| Ask/Build chat and conversational intake | 04,27,28 | /conversations, /messages, /intake | Ask no-write, mode switching |
| Flow and subflow orchestration | 03,10 | /flows, /flow-versions, /flow-runs | graph validation, resume |
| Worker scheduler, checkpoints | 05,15,32 | /internal/agent-runs, /checkpoints | lease fencing, crash recovery |
| Tools, sandbox and model context | 16,32,34 | /tools, /model-profiles, /contexts | sandbox escape, injection |
| Approvals, policies and budgets | 08,16,23,34 | /approvals, /policies, /budgets | immutable action digest, quota races |
| Preview, feedback and delivery | 21,22 | /previews, /feedback, /deliveries | immutable patch, user signoff |
| Settings and onboarding | 24,28,30 | /settings, /onboarding | real UI to live backend |
| Audit, lineage and observability | 09,15,33 | /audit, /lineage, /metrics | redaction, trace reconstruction |
| MCP and extension marketplace | 10,32,34 | /connectors, /mcp-servers, /extensions | malicious connector, permission review |
| ACP compatible sessions | 32,35,36 | /acp/sessions, /acp/events | handshake, resume, disconnect |
| Subagents and parent/child | 32,38 | /executions/{id}/children | budget escrow, cancellation, conflict |
| Self-modification governance | 08,34 | /self-modification/requests | independent approval, rollback |
| Security and identity | 16,34 | /auth, /memberships, /credentials | tenant isolation, token revocation |
| UX navigation and change management | 19–30 | /workspace-projections, /change-requests | end-to-end journeys |

## Completion method
Before coding, expand each row to atomic behaviors and enumerate endpoints, payload schemas and tests in a machine-readable traceability ledger. Do not interpret the list as an exhaustive endpoint specification. All functionality from 01–36 and the concept document must be checked against this inventory. All uncovered requirements are blockers, not assumed complete.
