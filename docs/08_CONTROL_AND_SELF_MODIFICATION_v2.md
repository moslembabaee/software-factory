# Control & Self-Modification v2

---

## 1. Two control classes

### Operational control

Acts on Work/Execution:

- approve
- pause
- resume
- retry
- stop
- reassign
- priority change

### Factory behavior change

Changes how Factory behaves:

- flow definition
- rule
- retry strategy
- watchdog/supervisor behavior
- actor binding
- worker policy
- connector/plugin
- permissions
- scheduled jobs

These require stronger authority.

---

## 2. Existing tools as control surfaces

GitHub/Jira/Slack/API/Workbench can emit equivalent commands.

Example:

```text
GitHub label: factory/approved
→ Event
→ Rule
→ Work approved
```

Source should remain visible in Timeline.

---

## 3. Protected control plane

Recommended repo layout:

```text
.factory/
  flows/
  rules/
  actors/
  jobs/
  policies/
```

Product Actor default:

```text
read: allowed as needed
write: denied unless explicit factory-change Work
```

---

## 4. Self-change path

```text
user request
→ Factory Change Proposal
→ proposed diff
→ validation
→ approval
→ merge/store
→ activation
→ activation Event
```

No silent rewrite.

---

## 5. Emergency stop

Independent control:

```text
dispatch_enabled = false
```

Effects:

- no new Execution
- optionally cancel active executions
- supervisor remains alive
- human must resume

Agent cannot override it.

---

## 6. Dynamic evolution

Factory may suggest missing capability.

Example:

```text
"I noticed blocked work is not visible enough."

Proposal:
- add blocked-by relation
- add UI badge
- prevent dispatcher selecting blocked Work
```

User approves → normal Factory Change path.

---

## 7. Rollback

MVP should at least keep previous config versions.

Activation failure:

```text
new version fails validation/runtime health
→ revert active version
→ Event
```


---

## v3 protected activation and approval rules

Policy checks are enforced at the credential broker, filesystem sandbox, Git gateway and connector gateway. Prompt instructions and `.factory/**` path conventions are advisory, not the security boundary. Default product agents have no write access to Factory policy, worker security configuration, or approval rules.

A Factory Change Proposal captures immutable base revision, exact proposed diff hash, tests, risk class, requesting principal and expiration. An authorized human approves **that hash only**; any modification invalidates approval. Activation is an atomic pointer swap to a validated immutable config version, with audit event in the same transaction. Existing Flow Runs remain pinned to their original version.

Security-critical rules, role mappings, emergency stop and credential broker policy cannot be changed through ordinary self-modification. Require separate administrative authorization and out-of-band recovery path. A rollback of config does not undo external side effects: document compensating actions and reconciliation.

Emergency stop blocks new dispatch and gateway writes, revokes leases/credentials where possible, and records which active sandboxes could not be forcibly stopped. Only a human admin can clear it after reconciliation. GitHub labels do not automatically grant approval; identity/role must be verified.


## Autonomous change governance (v6)

Agent-authored edits to policies, deployment workflows, credential scopes, runtime code or approval rules are **proposals only** and require independent human approval; agent may not self-approve or escalate its own permissions. Policy changes are versioned, audited and effective only on subsequent executions.
