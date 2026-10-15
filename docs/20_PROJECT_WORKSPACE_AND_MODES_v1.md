# Project Workspace & Modes v1 — normative
## Information architecture
Simple: Projects, Conversation, Plan, Progress, Preview, Decisions, Deliverables, Budget.
Advanced: same project plus Work Queue, Flow, Execution, Worker, Events, Git, Trace, Policies.
Mode is a user preference, not authorization. Switching never changes underlying data or grants permissions.

## Project model (product layer)
Project: id, owner, display name, description, repositories[], goal, stage, created_at.
Feature: id, project_id, goal, acceptance_criteria[], dependencies[], status, evidence_refs[], plan_version.
Decision: id, project_id, question, alternatives[], selected_option, rationale, author, timestamp, supersedes, impact_refs.
Plan: id, version, project_id, features[], exclusions[], assumptions[], cost_estimate_range, estimate_confidence, approved_by, approved_at.
These are product projections / tables as needed; do not force all fields into core metadata. Existing six core primitives remain intact.

## Progress truthfulness
Feature status: proposed, planned, building, verifying, ready_for_review, accepted, rejected, blocked. Only accepted features count as delivered. Do not show percent complete unless a stable denominator and weighting rule are documented; otherwise show accepted N of M, plus unknown scope.

## Mode transitions
Same URL/project context, reversible, accessible keyboard control. Advanced-only controls remain permission-gated. Persist selected mode per user. All user-facing statuses map to authoritative runtime states and link to evidence.

## Accessibility
Keyboard operable; visible focus; screen reader status announcements; color never sole status signal; RTL Persian and LTR technical tokens; mobile responsive; plain-language error copy.
