# Security, Trust Boundaries & Approval v1 — Normative

## Threat model
Untrusted inputs: issues, pull requests, repository files, retrieved documents, chat messages and tool outputs. Treat all as data, not instructions to elevate permissions. Agent prompt injection is assumed possible. Assets: repository, secrets, host filesystem, network, Git permissions, Factory policy and audit records.

## Boundaries
- **Agent sandbox:** isolated container/VM, non-root, CPU/memory/time quotas, no host sockets, protected mounts, network default deny; git worktree is not a sandbox.
- **Credential broker:** issue short-lived per-execution least-privilege tokens; no global environment secrets; revoke on cancellation/lease expiry.
- **Effect Gateway:** only component permitted to push branches, create PRs, write external issues, deploy or mutate Factory config. Check identity, fencing epoch, scope, budget and approval digest.
- **Control plane:** authenticated endpoints, role authorization and immutable audit. Agent cannot edit enforcement policy.

## Roles and approval
Roles for single-user secure mode: `owner_admin`, `operator`, `reviewer`, `agent`, `read_only`. Default deny. Reviewer can approve designated Work outputs but not policy changes; owner_admin is required for Factory configuration changes; high-risk security policy changes require out-of-band admin path.

Approval binds principal, subject type/ID, immutable SHA-256 digest, exact scope, decision, expiration, source and audit correlation. Any diff/config change invalidates prior approval. External labels are not authoritative until provider signature, identity and role checks succeed.

## Protected operations
Network egress, secret reads, Git pushes, merges, deployments, changes to `.factory/**`, shell execution and artifact publication are explicit capabilities. Read-only repository inspection may use a narrower sandbox. No agent can grant itself capabilities.

## Incident response
Emergency stop is outside agent authority; freeze new dispatch and privileged effects; revoke tokens; quarantine artifacts; record outstanding unknown operations. Resume requires operator reconciliation. Config rollback does not imply rollback of deployments or remote writes.

## Verification checklist
Prompt injection in issue text, symlink/path traversal into `.factory`, attempt to read host secret, unauthorized network access, forged GitHub label, stale approved diff, compromised worker credential, replayed webhook and emergency stop during external write must all be tested.


## Integrated enforcement (v6)

Approval is enforced server-side before privileged tool execution or publication; UI confirmation alone is insufficient. Require approval for production deploy, secret access, external writes, branch protection changes, and policy modifications. Deny by default on policy service outage.
