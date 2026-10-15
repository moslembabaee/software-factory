# Open Decisions & Risk Register v1

## Assumptions used in v3
Target: single-owner, single-repository, local-first operational MVP with potential later remote workers. No multi-tenancy or enterprise billing. If commercial multi-tenant deployment is planned, revisit isolation, identity, tenant partitioning, quotas and data residency before implementation.

## Decision log to close before production
| Decision | Default for v3 | Trigger to revisit |
|---|---|---|
| Operational database | PostgreSQL | prototype-only SQLite |
| Worker sandbox | isolated container with network restrictions | hostile code may require VM |
| State source of truth | relational state + outbox | full event sourcing requires separate ADR |
| Effect authority | central gateway | direct worker writes forbidden |
| Approval | exact immutable digest | multi-reviewer policies |
| Concurrent writes | isolated branches, serialized merge | cross-repository transactions |
| Tenant model | one owner | any external customer |
| Delivery | PR/merge handoff | deployment automation |

## Risks
| Risk | Severity | Mitigation | Owner |
|---|---|---|---|
| Duplicate external side effects | P0 | effect gateway, receipts, reconciliation | Runtime |
| Agent privilege escalation | P0 | sandbox and scoped credentials | Security |
| Lost flow wakeup | P0 | durable wait + transaction | Orchestration |
| Stale approval | P0 | digest-bound approval | Control |
| Conflicting branches | P1 | merge queue/retest | Git integration |
| Budget runaway | P1 | mandatory caps and alerts | Operations |
| UI hides uncertain state | P1 | decisions/reconciliation view | Product |

All P0 risks must have implemented tests and an explicit owner before real-world execution. Architectural documentation alone does not close a risk.
