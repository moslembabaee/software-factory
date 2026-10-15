# Software Factory — Security, Sandbox & Approvals

**Status:** normative security baseline

## Trust boundaries
User, repository contents, external docs, MCP responses and model output are untrusted. Factory policy service and signed worker identity are trusted control-plane components; tool gateway is the enforcement point. A model cannot grant itself new scopes.

## Execution isolation
Ephemeral non-root containers or microVMs per Execution; read-only base image; scoped writable worktree; no host socket; no privileged mode; seccomp/AppArmor or equivalent; CPU/memory/pid/time limits; default-deny egress; explicit allowlisted registries only where needed. Repo fetch uses short-lived credentials from broker, never in prompts. Wipe sandbox and revoke credentials at terminal transition.

## Policy matrix
| Action | Default | Approval |
|---|---|---|
| Read workspace | Allow in scoped repo | No |
| Edit workspace | Allow in isolated branch | No |
| Run tests | Allow sandboxed | No |
| Install dependencies | Restricted network allowlist | Policy dependent |
| External MCP write | Deny | Yes + scoped connector |
| Read secrets | Deny | Explicit scope and broker |
| Merge to protected branch | Deny | Yes |
| Deploy production | Deny | Yes |
| Change policy/agent permissions | Deny | Independent human review |

## Approval contract
Approval binds immutable action digest, execution ID, actor ID, policy version, expiry and reviewer identity. If arguments change, approval is invalid. Two-person review for high-risk production or policy changes where configured. Approval cannot be issued by the same agent requesting it. On timeout or policy outage, deny/suspend.

## Threat tests
Prompt injection in README, malicious tool output, path traversal, symlink escape, shell command injection, SSRF, credential exfiltration, event forgery, replayed approval, stale worker lease and budget bypass must be covered. Redact tokens and PII from event streams; keep audit events tamper-evident with restricted access.

## Supply chain
Pin dependencies, sign worker images, generate SBOM, scan vulnerabilities and secrets, validate provenance before deployment. Enforce tenant isolation at every query and artifact fetch.
