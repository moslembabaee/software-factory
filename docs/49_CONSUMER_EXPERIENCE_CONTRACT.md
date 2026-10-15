# Consumer experience contract — binding v6.3
## Goal and precedence
Deliver the **entire** Software Factory capability set in one complete build. This contract adds consumer-facing requirements; it does not remove advanced features or security approvals. In user-facing conflicts, safety/authorization invariants prevail; otherwise this contract governs consumer behavior over earlier UX prose.
## Product promise
A user can describe a product in natural language, receive a grounded plan and cost estimate, authorize a bounded run, observe a truthful progress view, interact with a verified result, request revisions, and receive a portable deliverable without understanding Git, queues or agents.
## Primary journey
1. Intake: capture objective, audience, platform, constraints, desired outcome and attachments; infer only reversible low-risk defaults; ask targeted questions for missing high-impact requirements. Preserve source wording and map it to testable acceptance criteria.
2. Before build: show understandable summary, scope, estimated cost range and uncertainty, spend ceiling, autonomy level and explicit approval for irreversible/high-risk effects. Never claim guaranteed cost/time.
3. During build: show what is done, underway, blocked and needing user action; use feature-level status backed by evidence, not invented percent-complete. Progress remains visible after refresh or reconnect.
4. Review: open the latest *verified* interactive preview or a truthful stack-appropriate alternative. Provide feature checklist and known failures. Allow rejection and revision without Git knowledge.
5. Delivery: show artifact/version, actual test evidence, installation/run instructions, secrets handoff, portability, ownership, limitations and rollback constraints. A completion label requires all mandatory gates and authorized acceptance.
## Progressive disclosure
Simple mode prioritizes Ask/Build, Product, Progress, Review, Cost and Delivery; Advanced mode exposes runtime, logs, approvals, policies, integrations and developer details. Both operate on identical backend objects and permission rules. Never hide critical security or spend consent. Default to plain-language error explanations with optional technical details.
## Question policy
Do not repeatedly ask for low-impact technical choices. Batch related questions when essential. Persist explicit preferences per project, allow revision, and surface a conflict before overwriting a previous instruction. Risky approvals remain separate and explicit; silence is never consent.
## Accessibility and localization
Keyboard-only paths, visible focus, semantic labels, screen reader status announcements, logical reading order, contrast at least WCAG 2.2 AA, reduced motion, and responsive layouts for 360/768/1280 px viewports. RTL layouts and locale-aware date, number, and currency display when Persian is selected. Localize status/error content, not only navigation.
## Error experience
For timeout, disconnected preview, budget exceeded, failed tests, blocked permission, unknown external side effect: state what happened, what remains safe, what is automatically recoverable, and the next safe action. Never show 'Retry' for an unreconciled non-idempotent side effect. Provide incident/reference ID and preserve unsent user text.
