# Ask / Build Interaction Contract v1 — normative
## Single conversation, explicit intent modes
Ask is read-only with respect to project state and external side effects. It may inspect permitted repository data, explain, analyze, and draft a proposed plan; no code writes, git pushes, deployments or persistent config changes. Build may propose and perform authorized work through Work/Execution lifecycle, never bypassing policy/approval. A mode toggle is not an authorization grant.
## Composer and transitions
Composer displays current mode, project, environment, expected side-effect class and attached context. Switching Ask to Build retains transcript and citations, but never auto-executes a previous suggestion. User explicitly confirms a scoped Build request; server performs authorization and budget checks. Ask may create an uncommitted plan proposal; only explicit acceptance persists executable intent. Build to Ask must not cancel already running work; cancellation is separate and explicit.
## Message types
User, assistant explanation, tool observation (redacted), plan proposal, config proposal, work status, approval request, artifact, error/recovery, system notice. Messages carry project_id, conversation_id, id, timestamp, actor, linked work/execution IDs, content version, visibility and correlation_id. Streaming text is provisional; finalized messages are durable and recoverable after refresh. Never imply execution succeeded based on model prose.
## User journeys
New idea: Ask -> clarifying questions -> plan with assumptions/exclusions/estimate -> user accepts -> Build -> preview -> feedback -> verification -> acceptance. Existing repo: connect with scoped access -> inspect -> identify uncertainties -> plan -> Build. Revisions are linked to prior feature and evidence; changed requirements invalidate affected approvals and acceptance as appropriate.
## Failure states
Missing repository access, unavailable model, budget exhausted, timeout, no preview, unverified result, approval expired and worker disconnected each show plain-language explanation, impact and safe next action. Retry is explicit when effects may not be idempotent. Show uncertainty rather than fake progress.
## Guardrails
Prompt content from repositories/issues is untrusted; it cannot authorize Build or config changes. Server-side checks enforce read-only Ask including tools and connectors. Do not store secrets in chat transcripts; redact sensitive tool output.


## Integrated Build mode (v6)

Build requests generate a proposed Work and plan, then explicit authorized Execution. Chat streams redacted progress/events and diff/test summaries, not raw secrets or hidden reasoning. Ask mode is read-only by default; transition to Build requires a deliberate user action.
