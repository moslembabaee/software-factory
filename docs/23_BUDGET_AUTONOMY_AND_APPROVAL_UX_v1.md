# Budget, Autonomy & Approval UX v1 — normative
## Budget
Show currency, estimate range, confidence, actual spend, committed spend, remaining cap and refresh timestamp. Estimates are not guarantees. Costs include model calls, compute and external services where measurable; unknown components explicitly marked. Enforce hard cap server-side; safe pause on exhaustion, no silent overrun.

## Autonomy profiles
Conservative: approval for material changes. Balanced (default): auto-run low-risk scoped work; approval for external side effects, secrets, production deployment, data deletion and policy changes. Supervised automation: broader preapproved scope with spend/time bounds; cannot override hard security rules. Profiles define UX defaults, not authorization bypass.

## Approval card
Plain-language intent, expected outcome, affected resources, risk tier, estimated incremental cost, reversibility, expiry, exact diff/hash or action parameters, approve/reject/request changes. Approval bound to identity, permission, content hash, plan version and expiry. Stale approvals are invalid.

## Notification policy
Group low-risk status updates. Interrupt for decisions blocking progress, cap reached, security events and failed delivery. Provide digest option, snooze noncritical items, and a clear Decisions Needed queue.
