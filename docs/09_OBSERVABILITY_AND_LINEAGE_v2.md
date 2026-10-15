# Observability & Lineage v2

**Goal:** هر اتفاق مهم یکجا قابل فهم باشد.

---

## 1. Questions the system must answer

For any Work:

- چرا ایجاد شد؟
- چه Eventهایی قبلش بودند؟
- چه کسی درخواست داد؟
- چه Rule/Flow تصمیم گرفت؟
- priority از کجا آمد؟
- approval چرا و توسط چه کسی داده شد؟
- چه Actorی انتخاب شد؟
- روی کدام Worker/Sandbox اجرا شد؟
- چه Executionهایی انجام شد؟
- آخرین progress چه بود؟
- چرا blocked/stalled/retried شد؟
- چه artifact/referenceهایی تولید شد؟
- چه verificationی انجام شد؟
- چرا تمام شد؟

---

## 2. Work Timeline is product-critical

```text
Event
→ Decision
→ Work
→ Flow
→ Actor selection
→ Execution
→ Progress
→ Reference
→ Verification
→ Next decision
```

---

## 3. Decision trace

برای تصمیم‌های مهم:

```text
decision_type
rule/flow ref
inputs summary
chosen action
reason?
timestamp
```

این می‌تواند Event payload باشد؛ entity جدید لازم نیست.

---

## 4. Progress

Minimum:

- running?
- last progress at
- progress source
- latest observable effect

`process alive != progress`

---

## 5. Blocked

Blocked یک observable coordination condition است.

At minimum:

```text
work.blocked event
reason
blocked_by reference/relation if known
```

Dispatcher باید blocked Work را runnable نداند.

---

## 6. Logs vs Events

Logs:

- debugging
- verbose
- retention shorter

Events:

- coordination history
- durable
- user-visible when important

---

## 7. Global Factory Activity

Workbench Home should show:

```text
recent events
queued works
running executions
waiting approvals
blocked works
stalled/unknown executions
worker health
factory changes pending approval
```

---

## 8. Metrics later

Only after real use:

- average completion time by Work category
- retry rate by Actor
- observed cost class
- stall rate
- queue time

Do not make these part of Actor identity.


---

## v3 operational SLOs and recovery visibility

Track per-Work time to acceptance, attempts, retry reasons, lease expiry, stale-worker rejections, duplicate inbox suppression, outbox backlog, pending reconciliation, budget spent, and acceptance vs execution success. Dashboard must surface `unknown` external effects and aging approvals. Alerts: outbox delay > 2 minutes, expired lease without reconciliation > 5 minutes, unauthorized gateway attempt (immediate), and restore-test failure. Thresholds are initial defaults to tune after baseline measurements.

Backup policy: nightly encrypted Postgres backup with 7-day minimum retention for MVP; restore drill at least monthly; recovery point/time targets must be selected by operator before production (do not promise untested RPO/RTO). Audit records are append-only and secrets are redacted.
