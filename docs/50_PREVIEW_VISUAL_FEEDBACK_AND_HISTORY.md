# Preview, visual feedback and version history — binding v6.3
## Preview modes
Web app: provide authenticated, isolated interactive preview with readiness check, build/commit identity and expiry. Mobile/desktop/CLI/backend: provide an appropriate executable artifact, simulator/session, API playground or reproducible local runner; never pretend a static screenshot is interactive. If environment cannot host a preview, explain precisely and offer a runnable alternative. No public exposure by default.
## Preview state model
`requested -> provisioning -> health_check -> ready | failed | expired | revoked`. A preview is `ready` only after HTTP/app-specific health verification and authorization. UI must display version, freshness and known limitations. Rebuild creates a new immutable identity; never silently reuse stale previews. Isolate untrusted code and scrub secrets from logs, URLs and screenshots.
## Point-and-request feedback
For DOM-capable web previews, selection captures stable element locator when possible, accessible label, bounding box, viewport, screenshot crop/reference, page URL path, preview build id, commit SHA, user comment and timestamp. Store no credentials or personal form values in captured images; redact sensitive content. For canvas/non-DOM apps, use coordinates plus screenshot and version. When selector cannot be resolved, request confirmation of target; never silently apply to an arbitrary element.
## Revision flow
Feedback -> clarification if ambiguous -> impact preview (affected features, data, cost, risk) -> authorization if required -> implementation -> regression and visual checks -> new preview -> user review. Original accepted version remains addressable. Distinguish reversible code/config rollback from irreversible external effects.
## History
Show human-readable versions with timestamp, requester, summary, preview/artifact link, evidence and changed features. Allow compare between two versions, including side-by-side screenshots when available, and guarded revert. Avoid implying deployment rollback also reverts database migrations or emails.
## Acceptance examples
- Feedback on a button after refresh still resolves against the recorded preview build, not latest build.
- User sees a clear 'preview expired' state; no dead link marked ready.
- Unauthorized user cannot view private preview or screenshot.
- Failed screenshot redaction blocks capture rather than leaking secrets.
- A revision failing regression tests cannot overwrite accepted baseline.
