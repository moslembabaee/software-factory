# Onboarding & UX Acceptance Tests v1 — normative
## First run
Choose create new or import existing. Explain privacy, model/provider access, cost caps, connected repositories and credential scopes. Offer a guided sample project without requiring external accounts where technically possible. Do not promise unsupported stack/deployment.

## Tests / release gates
UX-01 Nontechnical user starts project without Git vocabulary.
UX-02 Developer imports repository read-only and sees accurate scan confidence.
UX-03 Switching modes preserves project, selected feature and conversation state.
UX-04 User distinguishes proposed vs accepted features within 60 seconds.
UX-05 User rejects incorrect preview and requests revision without CLI.
UX-06 Budget hard cap pauses new billable work and explains existing committed cost.
UX-07 User sees what approval will do, exact scope and rollback limitations.
UX-08 Stale approval cannot authorize changed diff.
UX-09 Preview is labeled unavailable if health check fails.
UX-10 User exports source, decisions and delivery metadata.
UX-11 Refresh/relogin resumes accurate state and decision queue.
UX-12 Screen reader and keyboard complete core create-review-accept journey.
UX-13 Persian RTL text and code/path LTR are readable.
UX-14 Error states give next action, not just internal exception.

## Research
Test at least 5 nontechnical and 5 developer participants before broad release; track task completion, errors, time to first preview, comprehension of approval, and confidence. Targets must be set before study; no invented success claims.
