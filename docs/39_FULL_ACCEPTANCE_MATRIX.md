# Full-product acceptance gates — normative v6.1

Each gate requires automated evidence, not a written assertion. CI must publish test command, exit status, environment, timestamp, artifact hash and coverage of source requirements.

| ID | Required verification | Pass condition |
|---|---|---|
| SF-01 | Requirement traceability | Every capability in docs 01–30, 31–36, 37–42 mapped to code + test; no unexplained missing entries |
| SF-02 | API contracts | OpenAPI validates; invalid payloads rejected; pagination/idempotency/auth tested |
| SF-03 | Persistence | Fresh migration, rollback strategy, uniqueness, FK, tenant scoping, outbox atomicity tested |
| SF-04 | Runtime lifecycle | Illegal transitions rejected; AgentRun completion never marks unapproved Execution completed |
| SF-05 | Crash recovery | Kill worker before/after external call; no duplicate protected effect; unknown reconciles or suspends |
| SF-06 | Approval binding | Change branch/base SHA/patch/test evidence/policy invalidates approval; expired/replayed approval rejected |
| SF-07 | Sandbox | Path/symlink escape, SSRF, metadata access, credential exfiltration, privilege escalation and outbound network denied |
| SF-08 | Budget | Concurrent calls and parent/child allocations cannot exceed cap; unknown charges reserved |
| SF-09 | Multi-agent | Child cancellation cascades; independent worktrees; merge conflicts reviewed and retested |
| SF-10 | MCP/extensions/ACP | Auth scopes, schema validation, protocol compatibility, malicious response injection and disconnect/reconnect tested |
| SF-11 | Self-modification | No policy relaxation or protected merge without independent approval; rollback demonstrated |
| SF-12 | UX journeys | All Ask/Build, settings, workspace, preview, feedback and onboarding journeys exercised against live backend |
| SF-13 | Observability | Every effect traceable to Work/Execution, redacted, append-only, reconstructable after restart |
| SF-14 | Supply chain | Dependency lock, image digest, SBOM, vulnerability and secret scans; failures block release |
| SF-15 | Operations | Cold-start setup, backup/restore, migration, service restart and incident runbooks executed |
| SF-16 | Delivery | No placeholder endpoints or unimplemented advertised controls; all external blockers disclosed |

**Final acceptance:** all applicable gates pass. Real integrations that cannot be exercised remain `BLOCKED` and prohibit an unqualified production-ready claim. Security gates are release-blocking, never waived by feature completeness.


## v6.3 binding consumer addendum
Additional mandatory consumer acceptance gates: CX-01..CX-16 in 52_CONSUMER_ACCEPTANCE_TESTS.md.
