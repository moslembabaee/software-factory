# Runtime Architecture v2

**Status:** Implementation baseline  
**Based on:** Concept v54 + refined product requirements

---

## 1. High-level

```text
                 ┌───────────────────────────┐
                 │        Workbench          │
                 │ UI / API / Conversation   │
                 └─────────────┬─────────────┘
                               │
      GitHub/Jira/Slack ───────┼────── Scheduled Jobs
                               │
                               ▼
                         Event Intake
                               │
                               ▼
                         Rule Evaluation
                               │
                    ┌──────────┼──────────┐
                    ▼          ▼          ▼
                 Work       Flow       Control
                 Store      Runtime     Actions
                    │          │
                    └────┬─────┘
                         ▼
                     Dispatcher
                         │
               ┌─────────┴─────────┐
               ▼                   ▼
          Actor Selection       Worker Scheduler
                                   │
                                   ▼
                            Worker / Sandbox
                                   │
                                   ▼
                              Actor Adapter
                                   │
                                   ▼
                               Execution
                                   │
                      ┌────────────┼────────────┐
                      ▼            ▼            ▼
                 Supervisor     Verifier     Connectors
                      │            │            │
                      └────────────┴────────────┘
                                   │
                                   ▼
                            Events / Relations
                                   │
                                   ▼
                               Workbench
```

---

## 2. Components

### Event Intake

Webhook/API/UI/conversation/scheduler input را به Event ثبت‌شدنی تبدیل می‌کند.

### Rule Evaluation

تصمیم‌های coordination:

- create Work
- set priority
- gate by approval
- start/call flow
- pause/resume
- route Actor
- retry/failover
- create related Work

### Flow Runtime

Flow/Sub-flow را اجرا می‌کند.

Flow entity Core نیست؛ configuration/execution mechanism است.

### Dispatcher

Work runnable را پیدا می‌کند.

### Actor Selection

در MVP rule ساده:

- explicit actor
- tag/capability match
- fallback chain

بعداً می‌تواند history/availability را استفاده کند.

### Worker Scheduler

Execution را به Worker دارای ظرفیت و runtime مناسب می‌دهد.

### Worker

یک execution environment است؛ Actor نیست.

Worker می‌تواند local/remote/container/VM باشد.

### Sandbox

workspace ایزوله برای یک Execution یا Work.

### Actor Adapter

Actor را invoke/observe/cancel می‌کند.

### Supervisor

Execution health/progress را observe می‌کند.

### Verifier

شواهد لازم برای completion را بررسی می‌کند.

### Connectors

External systems.

---

## 3. Deployment evolution

### Stage 1

```text
factory-service
worker-local
postgres/sqlite
```

### Stage 2

```text
control-plane
  + worker-01
  + worker-02
  + worker-03
```

### Stage 3

Workerهای remote / ephemeral sandbox.

---

## 4. Important boundaries

```text
Actor ≠ Worker
Actor ≠ Sandbox
Execution ≠ Process
Flow ≠ Work
Flow Step ≠ Work by default
Workbench ≠ System of Record for Git
```

---

## 5. Runtime loop

```text
receive Event
→ persist Event
→ evaluate Rule
→ create/update Work
→ advance Flow
→ if runnable:
     choose Actor
     choose Worker
     create Execution
     prepare Sandbox
     invoke Actor
→ observe progress
→ collect References/Events
→ verify
→ update Work/Flow
→ emit next Event
```

---

## 6. Non-goals

- generic workflow engine
- arbitrary graph execution platform
- Kubernetes clone
- multi-agent framework
- hidden self-modification


---

## v3 normative runtime invariants

1. PostgreSQL is the operational default for concurrent deployments. SQLite is allowed only for a single-process prototype, with no claims of multi-worker safety.
2. One transaction commits each authoritative state transition, its audit Event, and its outbox delivery intent. No external side effect occurs inside that transaction.
3. **Only the Transition Coordinator** commits Work/Execution/Flow state changes. Rule, Supervisor, Flow and Dispatcher submit versioned commands; they do not independently mutate state.
4. Dispatch is an atomic claim of a runnable Work with `expected_version`, `lease_epoch`, `lease_until` and one active attempt policy. A retry creates a new Execution. A lease timeout does not prove the old worker stopped.
5. Each execution gets a monotonic fencing token. The control plane rejects stale heartbeat/result/commit commands. External writes require a guarded integration (or are classified as uncertain and escalated); fencing at the database alone cannot prevent an already-running agent from making external API calls.
6. Work completion requires distinct `execution_outcome`, `verification_outcome`, `acceptance_outcome`, and `delivery_outcome`. Execution success never implies Work acceptance.
7. On restart, reconcile outbox, expired leases, in-flight executions, waiting flows and external action receipts before scheduling new attempts.
8. Cancellation is cooperative until sandbox termination is confirmed. A canceled/stale execution cannot publish or merge results. Emergency stop blocks dispatch and privileged external effects at the enforcement gateway.

**Decision ownership:** Rule proposes commands; Flow decides intended next step; Supervisor reports health; Dispatcher selects candidates; Transition Coordinator validates transitions and commits them; Effect Gateway alone authorizes sensitive external effects.

**Operational modes:** `prototype` (one process, local non-sensitive repo), `single_user_secure` (Postgres, sandbox, scoped credentials), `multi_tenant` (explicitly out of MVP). Default target is `single_user_secure` with one owner and one repository; expanding to other trust boundaries requires a new ADR.

See `15_RELIABILITY_AND_RECOVERY_v1.md` and `16_SECURITY_AND_APPROVAL_v1.md`.


## Software Factory integrated agent runtime — normative v6 extension

The Factory Core remains authoritative for Work, Actor, Execution, Event, Reference and Relation. The autonomous coding engine is an **Agent Runtime Adapter** behind the Worker boundary, not a seventh core primitive. Dispatch creates an Execution; the adapter receives a bounded run envelope and emits append-only events, artifact references and a terminal outcome. Never let the agent mutate Factory tables directly. See `31_INTEGRATED_SYSTEM_ARCHITECTURE.md` and `32_AGENT_RUNTIME_AND_CONTEXT.md`.
