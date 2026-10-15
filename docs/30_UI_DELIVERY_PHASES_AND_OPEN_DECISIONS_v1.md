> **v6.2 full-build rule:** Any MVP, optional, deferred or phase language below describes historical sequencing only. Every documented capability is mandatory at final delivery; see 37 and 43–48.

# UI Delivery Phases & Open Decisions v1 — normative
## Vertical slice first
Phase UI-0: clickable information architecture and usability tests with one nontechnical and one developer persona. Phase UI-1: project shell, persistent conversation, Ask, Plan proposal, settings read. Phase UI-2: explicit Build confirmation, one sandboxed execution, activity and approval, files/diff/test evidence. Phase UI-3: preview, feedback/revision, acceptance and deliverables, basic budget and config proposal/apply. Phase UI-4: advanced diagnostics, multiple agents, Git controls and richer policy editing after runtime reliability gates.
## Done criteria
User can go idea -> plan -> explicit approval -> authorized build -> inspect preview/evidence -> request revision -> accept delivery without database or YAML editing. A developer can inspect the same execution through Advanced with linked logs/diff and no discrepancy in state. Error paths are tested and recoverable.
## Non-goals for MVP
Full cloud IDE, unrestricted interactive shell, multi-tenant billing, visual workflow designer, arbitrary remote deploy, app-store publishing, autonomous security-policy rewriting.
## Decisions to validate in prototype
Preview environment hosting (local vs remote), user authentication/provider, repository creation vs import, supported deployment targets, supported languages/frameworks, model vendors and cost reporting source, retention and workspace resource quotas. Keep these explicit; do not promise unsupported features.
## Dependencies
Read with docs 15-18 for reliability/security and 19-25 for product UX. This UI specification does not supersede execution fencing, approval hashing or sandbox isolation.
