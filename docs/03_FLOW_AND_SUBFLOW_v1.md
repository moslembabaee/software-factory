# Flow & Sub-flow v1

**Goal:** orchestration قابل فهم و قابل تغییر باشد، بدون ساخت BPM engine پیچیده.

---

## 1. Principle

Flow mechanism است.

Core فقط اثرات observable آن را می‌بیند:

- Event
- Work
- Execution
- Relation
- Reference

---

## 2. Minimal flow vocabulary

فقط این operationها برای v1 کافی‌اند:

```text
on event
run work
wait condition
call sub-flow
branch by rule
emit event
finish
```

---

## 3. Example: issue intake

```yaml
id: issue-intake

on:
  event: github.issue.created

steps:
  - run:
      work: understand-request
      actor: intake-agent

  - call:
      flow: impact-analysis

  - wait:
      condition: work.approved == true

  - call:
      flow: implementation
```

---

## 4. Example: impact-analysis sub-flow

```yaml
id: impact-analysis

steps:
  - run:
      work: inspect-related-components
      actor: architecture-agent

  - run:
      work: discover-prerequisites
      actor: architecture-agent

  - run:
      work: update-issue-summary
      actor: documentation-agent

  - emit:
      event: work.ready-for-approval
```

---

## 5. Why Sub-flow?

Main flow باید کوچک بماند:

```text
intake
→ prepare
→ approve
→ implement
→ verify
```

جزئیات `prepare` می‌تواند sub-flow باشد.

---

## 6. Flow state

Flow runtime می‌تواند این اطلاعات را نگه دارد:

```text
flow_run_id
flow_id
current_step
state
started_at
ended_at
context_ref
```

این‌ها Core primitive نیستند.

---

## 7. Modification

Flow باید versioned config باشد.

```text
flow v3 active
flow v4 proposed
```

تغییر flow:

```text
conversation/request
→ proposed diff
→ validation
→ approval if control-plane change
→ activate
→ activation Event
```

---

## 8. Guardrails

- loop نامحدود ممنوع یا bounded
- max retries
- timeout برای waits در صورت نیاز
- flow change روی run فعال نباید silent semantics change ایجاد کند
- flow config validation قبل از activation

---

## 9. Non-goals

- BPMN
- drag/drop designer در MVP
- arbitrary script language
- distributed transaction semantics


---

## v3 durable execution contract

`flow_definitions` are immutable once activated. Each `flow_run` pins `flow_id + flow_version`; nested runs also pin their own version. A deployment must retain old definitions while runs reference them.

Persist `flow_run`, `flow_step_runs` (unique `(flow_run_id, step_key, iteration)`), parent/child links, wait subscriptions, deadline, retry budget and completion receipt. Transition of a step and emission of the corresponding outbox event happen in one database transaction. `call sub-flow` uses a stable child idempotency key; on resume it reattaches rather than creating another child.

`wait condition` registers a durable subscription *and* evaluates the condition transactionally against a versioned state snapshot, preventing lost wakeups. Every wait must define deadline behavior (`fail`, `escalate`, or `continue`), even when the deadline is `none` with an explicit operational justification.

Retries apply to individual attempts, with exponential backoff + jitter, capped count and wall-clock deadline. Commands and effect receipts use stable idempotency keys. Never automatically retry a step with an unconfirmed non-idempotent external effect: mark `needs_reconciliation` and request operator review.

After restart: reload pinned definitions, reconcile unfinished step receipts, re-register waits, check deadlines, and resume only from committed step boundaries. Include crash-injection tests before/after step commit, event publication, sub-flow creation, and external effect.
