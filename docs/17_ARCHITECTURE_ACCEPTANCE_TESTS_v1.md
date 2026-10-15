# Architecture Acceptance Tests v1

These tests are **specifications**, not claims of passing implementation tests. CI should implement deterministic fault injection, use disposable repositories and mock external providers, and attach logs/receipts.

| ID | Scenario | Required assertion |
|---|---|---|
| AT-01 | Worker A alive after lease expiry; B retry | A cannot publish effects after epoch changes; uncertain A effects reconciled first |
| AT-02 | Crash between state commit and outbox publish | event eventually published, no lost transition |
| AT-03 | Same webhook delivered 3 times | exactly one logical Work, stable response |
| AT-04 | Crash after sub-flow created | one child run, parent resumes |
| AT-05 | Cancel during active execution | stale output rejected; termination status visible |
| AT-06 | Two branches touch same files | no silent overwrite; conflict Work visible |
| AT-07 | Agent tries `.factory` write | OS/gateway denies regardless of prompt |
| AT-08 | Diff changes after approval | prior approval invalid; new approval needed |
| AT-09 | Tests pass but acceptance fails | Work not completed |
| AT-10 | External API timeout after side effect | lookup/reconcile before retry |
| AT-11 | Budget exhausted | no further dispatch, clear reason |
| AT-12 | Unauthorized GitHub label | no approval transition |
| AT-13 | Event schema v1 consumed by v2 | version compatibility or explicit quarantine |
| AT-14 | Restore from backup | DB and outbox reconcile without duplicate external effect |
| AT-15 | Emergency stop during worker run | no new privileged effect; uncertain operations shown |
| AT-16 | Prompt injection in repository | cannot escalate permissions or exfiltrate secrets |

## Gates
**Prototype gate:** AT-02, 03, 09 and local restart tests. **Operational MVP gate:** all AT-01 through AT-16 pass in automated CI or documented operator drills where automation is not feasible. Record evidence link, owner, date and failures; unresolved P0 blocks operational release.


## Integrated agent acceptance suite (v6)

Extend baseline tests with AT-AGENT-01..12 in `35_BUILD_PLAN_AND_ACCEPTANCE.md`, including tool sandbox escape, approval bypass, duplicate callbacks, interrupted runs, budget exhaustion and deterministic replay.
