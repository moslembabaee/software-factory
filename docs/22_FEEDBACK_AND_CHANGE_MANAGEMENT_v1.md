# Feedback & Revision v1 — normative
## User-facing loop
Preview -> feedback -> proposed change -> impact analysis -> authorization -> execution -> reverification -> review.
Allow feedback on feature, screenshot location, or whole release; attach version/build and reproduce steps when available. Show whether request is bug, refinement, or scope expansion, but user can correct classification.

## Impact analysis
Before modifying accepted work, show affected features, dependencies, migration implications, approximate cost range, and what could be lost. Keep original acceptance evidence. New plan version supersedes previous; conflicting decisions are surfaced for explicit resolution.

## Undo semantics
Distinguish revert code, revert configuration, rollback deployment and compensate external side effects. Never advertise universal Undo. Show reversible scope and recovery limitations. Preserve audit trail and user approval on risky changes.

## Acceptance tests
A user can reject a visually wrong result without knowing Git; feedback becomes tracked change; old accepted version remains identifiable; concurrent changes are reconciled with plan version checks.
