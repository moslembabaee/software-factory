# Consumer executable acceptance — v6.4

Use pytest + HTTP client and Playwright against real isolated deployment. Required fixtures: two tenants, two projects per tenant, two reviewers, a revision with fixed commit/evidence SHA, a newer revision, redacted and unredacted screenshots, expiring preview, failure-injected worker, and bounded test budget. No test may report success without exit code, trace and immutable build identifier.

| Test | Actions | Assert |
|---|---|---|
| CX-01 | POST intake twice with same key | exactly one intake version; same response |
| CX-03 | reload browser during build | same execution ID; no duplicate work |
| CX-04 | GET preview before/after health check | URL absent until healthy+ready; SHA equals revision |
| CX-06 | POST feedback then create new revision | feedback still refers to original preview and revision |
| CX-07 | compare revisions from different projects | 404 without leaked metadata |
| CX-09 | timeout after external dispatch | unknown effect blocks retry and asks reconciliation |
| CX-10 | forecast exceeds cap | UI asks explicit authorization; cap unchanged |
| CX-11 | fail one critical user journey | verified/delivered states impossible |
| CX-12 | Playwright at 360,768,1280 px; axe audit | no dead controls, WCAG 2.2 AA issues triaged |
| CX-13 | Persian RTL page with mixed code/URLs | correct direction and keyboard order |
| CX-14 | request receipt with mismatched evidence | 409 ACCEPTANCE_MISMATCH, no delivery |
| CX-15 | cross-tenant preview and feedback access | 404/403, no metadata leak; redaction failure prevents storage |
| CX-16 | accept revision A then create B | B unaccepted; A receipt not silently changed |
| CX-RACE-01 | simultaneous decisions with same expected_version | one succeeds, one 409 |
| CX-RACE-02 | revoke preview during access | URL authorization rechecked; access denied |
| CX-RACE-03 | duplicate POST under timeout | same idempotency result, no double charge |

Evidence: HTTP trace, sanitized screenshots, schema validator report, SQL migration test output, reviewer ID, correlation IDs, git SHA, timestamps. This is a test specification, not a claim that tests have run. Generate executable pytest/Playwright suites and run in CI as a build acceptance gate.
