# v6.5 audit and remaining implementation gaps

This amendment strengthens completion gates, immutable consumer artifact identity, concurrency, and runnable-test obligations. It does not falsely claim to implement the system.

Still outstanding before a genuinely no-ambiguity build: comprehensive OpenAPI for all non-consumer capability families, full DB schema/migrations for all extension and agent subsystems, consistent authorization on all older tables, executable tests against a running app, deployment environment configuration, and measured security/performance results. These are release blockers, not permission to omit product features.

## Conflict precedence
1. This document and docs 58–60 for release, concurrency, and evidence; 2. docs 37–57 for full scope and consumer contracts; 3. docs 31–36 for architecture; 4. historical docs 01–30 and 99 as contextual input. More-specific security restrictions always prevail over convenience wording. Any irreconcilable conflict is a blocked decision with evidence, not an agent assumption.
