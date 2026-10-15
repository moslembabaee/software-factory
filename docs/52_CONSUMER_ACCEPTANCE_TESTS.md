# Consumer acceptance tests — binding v6.3
All tests must be automated where practical (browser E2E + accessibility + contract tests) and accompanied by manual evidence for subjective visual quality. No self-reported 'pass' without evidence. Cover English and Persian RTL when selected. The tests below extend, not replace, SF-01..SF-16.
| ID | Scenario | Pass criteria / evidence |
|---|---|---|
| CX-01 | Nontechnical user starts from natural-language brief | Requirement summary, open assumptions, cost range and testable outcomes displayed before authorized run; no Git terms required |
| CX-02 | Low-risk technical choices | No redundant questions for documented defaults; high-risk consent still explicitly required |
| CX-03 | Reload during run | Feature statuses, messages and approvals restored without duplicated job submission |
| CX-04 | Web preview ready | Only verified reachable and authorized URL marked ready; build SHA matches reviewed revision |
| CX-05 | Non-web project | Executable/simulator/API test route documented and exercised; screenshot alone not accepted |
| CX-06 | Visual element feedback | Stored selector/coordinates + build id + redacted screenshot; change references original revision |
| CX-07 | Version comparison | User can compare two revisions, view changed features and safely request a guarded revert |
| CX-08 | Failed test and blocked tool | Plain-language cause, safe next action, evidence link; no false completion claim |
| CX-09 | Unknown external operation | UI suppresses blind retry; reconciliation or manual review required |
| CX-10 | Cost increase | Revised range and assumptions visible; cap not increased without explicit authorization |
| CX-11 | End-user acceptance | Critical journeys mapped to brief and exercised in actual target environment; failed journey blocks Verified |
| CX-12 | Responsive and accessible | Keyboard path, focus order, screen reader labels, contrast WCAG 2.2 AA; 360/768/1280 viewport tests |
| CX-13 | RTL localization | Persian content direction, mixed LTR code/URLs, numbers and currency render correctly |
| CX-14 | Delivery receipt | Artifact identity, reproducible run guide, tests, known limitations, portability and ownership info present |
| CX-15 | Data/security privacy | Unauthorized preview/feedback denied; sensitive form values absent from screenshot and logs |
| CX-16 | Regression after feedback | Previously accepted critical flows rerun; failing change does not overwrite accepted release |

## Evidence bundle
For each CX gate record requirement IDs, test command and exit code, environment, browser/device, timestamp, immutable artifact/build id, screenshots or trace with redaction, and reviewer status. Visual assessment must include no dead controls, broken layout, clipped content, unreadable typography or misleading success states. User approval cannot be fabricated by an agent.
