# Unified Web Workspace & Navigation v1 — normative
## Product contract
One browser-based Software Factory workspace with one project context and two reversible presentation modes: Simple and Advanced. Neither mode changes permission or execution authority. Responsive mobile layout uses tabs rather than three simultaneously visible panes. No desktop IDE is required for MVP.
## Desktop shell
Top bar: project switcher, current project/environment, runtime status, budget status, mode switch, settings, account. Left rail: projects, conversation, plan/tasks, preview, deliverables, decisions, settings. Center pane: conversation with Ask/Build selector, messages, plan cards, approval cards and composer. Right pane: tabbed Preview, Files, Diff, Tests; Advanced adds Terminal, Logs, Trace, Flow, Workers. Panels resizable and collapsible, persisted per user and project. A visible activity indicator is not evidence of completion.
## Simple mode
Default landing is Conversation with contextual Plan and Preview. Present feature outcomes, next action, delivery status, budget estimate/actual. Avoid exposing raw execution identifiers unless expanded. Show decisions requiring attention prominently.
## Advanced mode
Same conversation and project data, plus Work Queue, Flow Graph, executions, worker health, Git branches/PRs, event trace, policy/config editor. Advanced is a visibility preference, not a privilege escalation.
## Navigation and resilience
Deep links to project, conversation message, work, execution, approval, preview and config proposal. Preserve drafts when switching modes/tabs. Reconnect after network loss; show stale/offline indicator and last sync time. All actions have pending/success/failure states and correlation IDs for support.
## Accessibility and localization
Keyboard-first focus order, accessible panel labels, live announcements for important statuses, 200% zoom, high contrast, RTL layout for Persian while code, paths and hashes remain LTR. Avoid conveying state by color alone.
## MVP boundaries
MVP: desktop web, responsive tabs, project selector, Ask/Build, Plan, Preview (where runnable), Files/Diff read-only, approval inbox, budget, basic settings. Advanced terminal write access and visual flow editor are later, subject to security review.
