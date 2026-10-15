# Residual decisions and release blockers

| ID | Decision | Safe build-time handling | Production gate |
|---|---|---|---|
| DEP-01 | Hosting and region | Deployable infrastructure templates with configuration | Owner confirms jurisdiction/region |
| DEP-02 | Model vendor/key/pricing | Provider adapter + deterministic test provider | Real provider credentials and cost evaluation |
| DEP-03 | Git provider | Local Git integration + remote adapter contracts | Provider-specific integration tests |
| DEP-04 | Isolation strength | Hardened OCI default with disabled untrusted runs if tests fail | Threat-model signoff; microVM if needed |
| DEP-05 | Retention/SLO/quota | Configurable, conservative values and load test harness | Operator approves measured targets |
| DEP-06 | ACP interoperability | Versioned adapter and conformance harness | Tested against selected clients |

No entry permits silently omitting a capability. Record owner, decision date, rationale, rejected alternatives, code impact and acceptance evidence for each resolved entry. Never claim production readiness with unresolved release blockers.
