# Workspace UI Acceptance Tests v1 — normative
1. New nontechnical user starts from natural-language idea without creating a repo manually; system clearly states any unsupported provisioning step.
2. Existing repo user connects least-privilege credentials, inspects analysis in Ask, and sees no repository writes.
3. Ask-to-Build retains context but cannot trigger execution until explicit confirmation and server authorization.
4. Build-to-Ask does not silently cancel an active execution; Cancel is separate and reports actual state.
5. Same project in Simple and Advanced has identical underlying status, approvals, cost and deliverables.
6. Advanced mode does not unlock shell, secrets, deployment or policy edits for unauthorized user.
7. Chat config request generates validated typed diff; rejection leaves config unchanged.
8. Stale config proposal fails version/hash check; approval of old diff cannot apply a newer patch.
9. Network loss mid-chat restores finalized messages, identifies provisional text and avoids duplicate Build submission.
10. User can open Preview, Diff and Tests linked to the same deliverable; unavailable Preview has an honest explanation.
11. Budget exhausted stops new paid work safely, displays actual vs estimate, and offers authorized next steps.
12. Mobile tab navigation and Persian RTL with LTR code paths pass keyboard and screen-reader checks.
13. Tool output containing prompt injection cannot authorize config changes, execution or credential access.
14. Approval card summarizes effect, risk, exact target and reversibility; expired approval cannot execute.
15. Browser refresh or project switch preserves composer draft and never duplicates a pending action.
16. All important actions have accessible pending, success and failure feedback tied to authoritative backend state.
## Release gate
Treat tests 2,3,5,6,7,8,9,13,14 as blocking security/correctness gates. Record test evidence and responsible owner; no release based only on visual review.
