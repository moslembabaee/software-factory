# Consumer cost, recovery and delivery contracts — binding v6.3
## Cost projection
Show `spent`, `reserved`, `remaining_limit`, `estimate_low`, `estimate_high`, estimate assumptions, updated_at and confidence label. Define remaining_limit = authorized_cap - spent - reserved; clamp UI display to zero, but retain signed value for audit. Cost estimates are ranges, not promises. Re-estimate on scope/model/tool changes and disclose cause of change. Hard-stop before exceeding cap except unavoidable provider billing reconciliation, which must be reported transparently. No auto-increase of cap.
## Permission levels
Provide consumer-readable choices: suggest-only; execute reversible sandbox work; request permission for protected effects. Technical policies still control individual tools; no single 'auto approve everything' option bypasses high-risk approvals. Approval displays action, exact target, impact, expiry and revoke path.
## Recovery UX
Translate system states into: Working, Needs your decision, Recovering safely, Could not finish, Ready for review, Delivered. Preserve detailed technical state in Advanced mode. For failed runs offer safe resume from checkpoint, inspect issue, or restart from clean state where supported. For unknown external effects, lock repeat action pending reconciliation. Disclose whether generated artifacts and edits were preserved.
## Completion contract
'Built' means artifacts produced; 'Verified' means evidence-backed tests passed; 'Accepted' means authorized user approved; 'Delivered' means requested export/run/deployment outcome actually verified. Do not collapse these states. Delivery packet includes exact artifact hash, repository/export link if authorized, dependency lockfiles, setup guide, env-variable template without values, data export instructions, license/ownership caveats, test summary, limitations, maintenance and rollback procedures. Require user-visible final checklist and receipt.
## Failure modes
- Budget estimate changed: show prior/new range and reason, request cap change only if needed.
- Network loss: preserve draft, restore status from server, deduplicate submit with idempotency key.
- Failed deployment: do not mark delivered; show verified previous live version and recovery plan.
- Incomplete test evidence: mark 'not verified' even when build exits zero.
