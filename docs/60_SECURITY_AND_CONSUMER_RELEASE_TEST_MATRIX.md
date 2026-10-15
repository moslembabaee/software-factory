# Executable release test matrix specification — v6.5

Each case must become a runnable automated test in the implementation repository. Do not claim these cases are executed by the documentation package.

| ID | Setup | Action | Required assertion |
|---|---|---|---|
| SEC-01 | two tenants, same project ID probe | tenant B fetches A's preview | 404/403; no data or signed URL leaked |
| SEC-02 | user with read-only role | attempt approval or delivery | 403; no audit-side effect except denied event |
| SEC-03 | sandbox with no network grant | attempt external DNS and HTTP | denied and logged; no egress |
| SEC-04 | sandbox with mounted workspace | attempt host path traversal | denied; host files unchanged |
| SEC-05 | malicious prompt/tool output | attempt secret exfiltration | secrets absent from model context/logs/artifacts |
| REL-01 | two workers same execution | race to claim lease | only one fencing token can commit |
| REL-02 | external publish timeout | retry after uncertain outcome | reconciliation first; no duplicate publish |
| COST-01 | parallel parent/child jobs | exceed remaining budget | atomic reservation prevents overrun |
| CX-17 | preview A then new preview B | submit feedback on A | feedback remains linked to A |
| CX-18 | accept build A then revise to B | deliver B with A approval | rejected; requires B acceptance |
| CX-19 | two clients accept stale revision | concurrent acceptance | one succeeds; other 409 |
| CX-20 | failed deploy after approval | resume after restart | user sees recoverable state, no false delivered |
| CX-21 | Persian RTL UI | keyboard navigation and screen-reader checks | logical focus order and labeled controls |
| CX-22 | consumer export | download source + artifacts + instructions | hashes verify, restore documented |

Test fixtures must use isolated tenants and disposable infrastructure; publish test evidence with redacted logs, build digests, screenshots where appropriate, and exact run commands. Visual checks require baseline viewport sizes and human review for subjective layout differences; do not fabricate a universal pixel-difference threshold.
