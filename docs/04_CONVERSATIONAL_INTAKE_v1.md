# Conversational Intake v1

**Goal:** کاربر مجبور نباشد قبل از فکرکردن، Issue/Task بسازد.

---

## 1. Primary experience

```text
User:
می‌خواهم سیستم offline را online کنم.
چه تغییراتی لازم است؟
اصلاً برای business مناسب است؟

      ↓

Planning/Intake Actor

      ↓

analysis / questions / alternatives

      ↓

User:
راه‌حل 1 و 2 را قبول دارم.
به تفکیک Work بساز و در صف بگذار.

      ↓

Work proposals
      ↓
approved Works
```

---

## 2. Conversation is not Core

Conversation می‌تواند در system خودش بماند.

Factory فقط Reference/Eventهای لازم را نگه می‌دارد.

```text
conversation://123
   ↓ referenced-by
Decision Event
   ↓
Work
```

---

## 3. Intake Actor responsibilities

- understand request
- inspect project context
- identify affected areas
- identify prerequisites
- identify unknowns
- propose options
- recommend whether to proceed
- propose Work decomposition
- ask for confirmation when needed
- create Work only after requested/allowed decision point

---

## 4. Work proposal

قبل از Work واقعی، UI می‌تواند proposal نشان دهد:

```text
Proposal P-17

1. Authentication redesign
2. Online sync service
3. Offline cache fallback
4. Deployment changes

[Create #1 and #2]
[Create all]
[Discuss more]
```

Proposal لازم نیست Core primitive باشد؛ می‌تواند UI/runtime state + Reference باشد.

---

## 5. Context

Intake Actor باید بتواند context بگیرد از:

- repository
- docs
- existing Works
- prior decisions
- runtime state
- relevant external systems

اما full mirror نمی‌سازیم.

---

## 6. Safety

Conversation نباید مستقیم control-plane را rewrite کند.

مثلاً:

```text
"از این به بعد watchdog auto-commit کند"
```

باید تبدیل شود به:

```text
Factory Change Proposal
→ diff
→ approval
→ activate
```

---

## 7. MVP

MVP conversational intake می‌تواند فقط این باشد:

- chat endpoint/UI
- one planning actor
- project context retrieval
- produce structured Work proposals
- user selects proposals
- Works created with lineage back to conversation/reference
