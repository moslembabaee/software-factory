# Factory Workbench v1

**Status:** Product/UI baseline  
**Goal:** کاربر بتواند بدون رفتن بین GitHub، log، terminal و Agent conversation بفهمد Factory الان چه می‌کند و چرا.

---

## 1. Workbench چیست؟

Workbench UI اصلی coordination است.

GitHub/Jira/Slack همچنان می‌توانند control surface باشند، اما Workbench باید بتواند end-to-end state و lineage را نمایش دهد.

---

## 2. صفحه‌های MVP

### 2.1 Inbox / Intake

ورودی‌های جدید:

- conversation proposal
- external issue
- webhook/event
- scheduled job
- manual request

نمایش:

- source
- summary
- proposed next action
- whether Work exists yet

### 2.2 Work Queue

برای هر Work:

- title / intent
- state
- priority
- current actor
- current execution
- blocked?
- waiting approval?
- last progress
- created by / source
- why it exists
- next expected action

### 2.3 Work Detail

باید بتوان پاسخ داد:

```text
این Work از کجا آمد؟
چه Eventهایی باعث ایجادش شدند؟
چه کسی/چه Ruleی آن را ایجاد کرد؟
priority چرا این است؟
چه چیزی آن را approved کرد؟
چه Actorهایی روی آن کار کرده‌اند؟
چه Executionهایی اجرا شده؟
کجا fail/stall/retry شده؟
چه Referenceهایی تولید شده؟
الان چرا blocked/waiting/running است؟
```

### 2.4 Timeline

نمای append-oriented:

```text
10:02 Event: issue_created
10:03 Rule: create-work
10:03 Work W-104 created
10:04 Sub-flow: impact-analysis started
10:06 Actor: architecture-agent selected
10:06 Execution E-201 started
10:11 Reference: analysis.md produced
10:12 Work W-105 created
10:13 waiting_for_approval
10:18 User approved
10:19 implementation-flow started
```

### 2.5 Flow View

هدف visualization ساده است، نه BPM editor.

نمایش:

- current flow
- sub-flow
- current step
- waiting condition
- completed steps
- failed/retried path

### 2.6 Actors & Workers

Actors:

- id
- kind optional
- tags/hints
- current availability observation
- recent execution history

Workers:

- online/offline
- capacity
- active executions
- runtimes supported
- sandbox type

### 2.7 Factory Changes

برای تغییر behavior خود Factory:

- proposed change
- diff
- reason
- requester
- approval
- activation event

---

## 3. Actions در UI

روی Work:

- approve
- pause
- resume
- retry
- stop
- change priority
- reassign
- add comment
- create related Work

روی Factory change:

- approve
- reject
- activate
- rollback to previous version if supported

---

## 4. GitHub/Jira/Slack

Workbench جای این ابزارها را نمی‌گیرد.

مثلاً:

```text
GitHub label factory/approved
        ↓
Connector Event
        ↓
Rule
        ↓
Work resume
```

همین action باید در Workbench هم دیده شود.

---

## 5. Non-goals

- source-code browser کامل
- GitHub replacement
- Jira replacement
- log viewer عمومی
- visual BPM designer پیچیده


---

## v3 outcome-oriented UX additions

The Workbench must show three first-class views alongside activity: **Decisions Needed** (approval, conflicts, uncertain effects), **Deliverables** (diff/PR, acceptance evidence, delivery status), and **Project Health** (failed/stalled/blocked work, budget, retries, unresolved recovery). Clearly distinguish proposed, approved, executed, verified, accepted and delivered. A user can inspect exact diff hash and authority before approval, revoke pending approval, and see why a Work is not runnable. Never present `execution.completed` as `work.completed`.
