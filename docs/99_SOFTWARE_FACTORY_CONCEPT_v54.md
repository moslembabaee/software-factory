# Software Factory Concept

**Version:** v54  
**Status:** Concept — Minimal control surfaces and protected self-modification boundary

> **Software Factory یک System of Coordination برای تولید نرم‌افزار است.**  
> ابزارها، انسان‌ها، Agentها و runtimeها می‌توانند عوض شوند؛ Factory فقط آن بخشی از واقعیت را مدل می‌کند که برای coordination و trace لازم است.

---

## تغییر این iteration

- تمام simplificationهای v53 حفظ شدند؛ Core بزرگ نشد.
- ابزارهای موجود مثل GitHub/Jira/Slack می‌توانند **control surface** Factory باشند؛ لازم نیست هر کنترل از UI اختصاصی Factory انجام شود.
- Eventهایی مثل approval، label، comment یا command می‌توانند از طریق Rule باعث `start / pause / resume / retry / stop / reassign` شوند.
- کنترل عملیاتی روی Work از تغییر رفتار خود Factory جدا شد.
- تغییر code/config/policy مربوط به خود Factory یک **self-modification** است و باید authority سخت‌تری داشته باشد.
- بودن فایل‌های Factory کنار repo پروژه مجاز و حتی مفید است، ولی co-location به معنی permission یکسان نیست.
- `scheduled jobs`, `skills`, `tools`, `connectors`, `plugins` به‌عنوان vocabulary مفید Runtime/Extension پذیرفته شدند، اما هیچ‌کدام primitive جدید Core نشدند.
- scheduled job در ساده‌ترین حالت Ruleی است که در زمان/trigger مشخص Work می‌سازد.
- skill/tool/connector/plugin mechanism یا packaging هستند و فقط اثر observable آن‌ها برای Factory اهمیت دارد.

### سؤال حذف در این نسخه

برای هر مفهوم پرسیده شد:

1. اگر حذفش کنیم، آیا هنوز می‌توانیم Work را coordinate کنیم؟
2. اگر حذفش کنیم، آیا هنوز می‌توانیم بفهمیم چه اتفاقی افتاد؟
3. آیا این مفهوم واقعاً در boundary Factory مشاهده می‌شود، یا فقط جزئیات implementation بیرونی است؟
4. آیا می‌توان همان نیاز را با primitiveهای موجود یا metadata ساده بیان کرد؟
5. آیا وجود این abstraction امروز لازم است، یا فقط «شاید بعداً» مفید باشد؟

اگر پاسخ‌ها ضرورت را ثابت نکنند، مفهوم حذف می‌شود.

---

## 1. ایده در یک نگاه

سیستم‌های موجود کار تخصصی خودشان را انجام می‌دهند:

- GitHub / GitLab → code, commit, PR/MR
- Jira / Linear / ServiceNow → issue/ticket
- Slack / Teams → گفتگو
- Agent Runtime → اجرای Agent
- CI/CD → build/test/deploy
- workflow/integration tools → automation

Factory قرار نیست جای این‌ها را بگیرد.

Factory فقط می‌خواهد بتواند این زنجیره را بفهمد:

```text
Something happened
      ↓
Work exists
      ↓
Actor participates
      ↓
Execution happens
      ↓
References / events are produced
      ↓
Next work or terminal state
```

اصل مرکزی:

> **Keep ownership where it already belongs. Keep only what coordination needs.**

---

## 2. Actor — فقط چیزی که Factory می‌بیند

`Actor` یک identity قابل آدرس‌دهی است که می‌تواند در Work مشارکت کند.

```text
Work ──> Actor
```

Factory لازم نیست بداند پشت Actor چه چیزی وجود دارد.

```text
actor://security
        │
        └── opaque
             ├── شاید یک Agent
             ├── شاید چند Agent
             ├── شاید Human + Agent
             ├── شاید یک تیم انسانی
             └── شاید یک سرویس خارجی
```

تا وقتی Factory مستقیماً با اجزای داخلی coordinate نمی‌کند، آن اجزا **در مدل Factory وجود ندارند**.

اگر روزی Factory نیاز داشته باشد با دو عضو داخلی جداگانه کار کند، آن دو عضو همان لحظه Actorهای مستقل می‌شوند.

```text
Internal composition ≠ Factory coordination topology
```

قاعده:

> **No topology unless Factory coordinates it.**

Human یا Agent بودن می‌تواند attribute باشد، ولی نباید مسیر اصلی coordination را دو شاخه کند.

```yaml
actors:
  - id: sara
    kind: human

  - id: backend-agent
    kind: agent
```

Core باید برای هر دو همان مسیر را ببیند:

```text
Work → Actor → Execution
```

---


## 3. Actor hints و چیزهایی که بعداً یاد می‌گیریم

اطلاعاتی مثل هزینه، سرعت، کیفیت، load و availability معمولاً ویژگی ذاتی و ثابت Actor نیستند.

یک Actor ممکن است برای یک نوع Work ارزان و سریع باشد و برای Work دیگری گران یا ضعیف. بنابراین Core نباید چنین چیزی را فرض کند:

```text
actor.cost = 1$
actor.quality = 0.9
actor.speed = fast
```

مدل ساده‌تر:

```text
Actor = identity + interface
Execution = what actually happened
History = what we learned
```

در صورت نیاز می‌توان چند hint بسیار coarse و اختیاری داشت:

```yaml
actor: coding-agent-a
tags:
  - cheap
  - fast
  - good-for-bugfix
```

یا:

```yaml
actor: sara
tags:
  - expensive
  - strong-for-architecture
```

این tagها فقط **hint** هستند، نه truth.

قاعده:

> **Declared hint < Observed history**

یعنی اگر Actor خود را `fast` معرفی کرده ولی executionهای واقعی خلاف آن را نشان می‌دهند، تصمیم‌های بعدی بهتر است به history تکیه کنند.

Factory لازم نیست از روز اول مدل آماری یا scoring پیچیده داشته باشد. history کافی است تا بعداً در صورت نیاز چیزهایی مثل این استخراج شوند:

```text
observed cost for this kind of Work
observed completion time
observed success/failure pattern
current availability/load
```

اما این‌ها projection/observation هستند، نه بخشی از identity Actor.

قاعده طراحی:

> **Do not model as static what can be learned from execution history.**

و:

> **Actor describes identity and interface; performance belongs to history.**

---

## 4. Core

Factory برای identity و trace فقط این primitiveها را نیاز دارد:

| Primitive | مسئولیت |
|---|---|
| **Work** | کاری/intentی که باید پیگیری شود. |
| **Actor** | هویت قابل آدرس‌دهی که می‌تواند در Work مشارکت کند. |
| **Execution** | یک attempt واقعی برای انجام Work. |
| **Reference** | اشاره به چیزی داخل یا خارج Factory بدون مالک‌شدن آن. |
| **Relation** | رابطه قابل‌ردیابی میان چیزها. |
| **Event** | اتفاق ثبت‌شدنی که history را قابل بازسازی می‌کند. |

چرا این‌ها جدا هستند؟

```text
Work      = what needs progress
Actor     = who/what participates
Execution = one real attempt
Reference = where something lives
Relation  = how things are connected
Event     = what happened
```

قاعده مهم:

> اگر یک مفهوم با همین شش مورد + metadata قابل بیان است، primitive جدید نساز.

---

## 5. Work و Execution

`Work` هویت کار را نگه می‌دارد. `Execution` یک attempt برای جلو بردن آن است.

```text
Work W-10
  ├── Execution E-1
  ├── Execution E-2
  └── Execution E-3
```

retry یا تغییر runtime به‌صورت پیش‌فرض Work جدید نمی‌سازد.

Work جدید زمانی معنی دارد که خود intent مستقل شده باشد.

```text
Execution completed ≠ Work completed
```

یک Execution می‌تواند موفق تمام شود ولی Work هنوز به attempt دیگری نیاز داشته باشد.

خروجی Execution با status/metadata و `Reference`ها ثبت می‌شود؛ برای Result/Outcome entity جدا لازم نیست.

### Execution supervision

یک Execution ممکن است شروع شود اما بعد stall، timeout، disconnect یا unknown شود. Factory باید بتواند این واقعیت را مشاهده و در history ثبت کند، اما لازم نیست خودش حتماً supervisor را پیاده‌سازی کند.

```text
Execution started
      ↓
   running
      ↓
progress? ── no ──> stalled / unknown
      │                 ↓
     yes            Rule decides
      │          retry / recover / stop
      ▼
  completion
```

دو قاعده مهم:

> **Running ≠ Progressing.**

و:

> **Execution may need observation and recovery; the supervision mechanism is replaceable.**

`watchdog`, `orchestrator`, queue worker, runtime monitor، Kubernetes یا حتی Human می‌توانند این observation/recovery را انجام دهند. هیچ‌کدام primitive جدید Core نیستند.

Factory فقط باید بتواند factهای مهم را ببیند یا دریافت کند:

```text
execution started
progress observed
progress stalled
timeout / disconnect
recovered
retried
completed / failed / cancelled / unknown
```

این taxonomy قرارداد اجباری Core نیست؛ مثال factهای قابل ثبت است. Event و metadata کافی‌اند.

---

## 6. External World

داده authoritative تا حد ممکن در سیستم خودش می‌ماند.

```text
Factory
  │
  ├── ref → Jira ticket
  ├── ref → GitHub PR
  ├── ref → Agent run
  └── ref → Deployment
```

Factory نباید این‌ها را دوباره بسازد:

- issue tracker
- git hosting
- chat platform
- agent runtime
- CI/CD engine
- workflow engine عمومی
- knowledge store عمومی

`Reference` یعنی «می‌دانم این چیز کجاست»، نه «مالک آن هستم».

```text
Cache ≠ ownership
Projection ≠ source of truth
```

---

## 7. Event و ورودی

ورودی بیرونی همان Event/Input است. مفهوم جداگانه Signal لازم نیست.

```text
External event
      ↓
Rule
      ↓
Work?
```

هر Event الزاماً Work ایجاد نمی‌کند.

حداقل اطلاعات مفید Event:

```text
id
source
occurred_at
correlation_id?
causation_id?
```

اگر وضعیت بیرونی نامعلوم است، Factory حدس نمی‌زند؛ adapter دوباره از مرجع بیرونی بررسی می‌کند.

---

## 8. Rules

Factory برای تصمیم‌های coordination فقط به Rule نیاز دارد.

```text
when X → create Work
when Work needs Y → choose Actor
before action Z → require condition Q
```

Capability، permission، approval، risk یا human gate می‌توانند input همین Rules باشند؛ لازم نیست برای هرکدام subsystem مفهومی بسازیم.

Rule فقط باید بتواند توضیح دهد چه تصمیمی گرفت و چرا، اگر آن تصمیم برای audit مهم است.

Rule همچنین می‌تواند نسبت به observationهای Execution واکنش نشان دهد:

```text
when execution stalled → inspect / recover / retry
when actor unavailable → choose another Actor
when progress is healthy → do nothing
```

خود observation یا recovery mechanism لازم نیست داخل Rule engine یا Core باشد؛ فقط effect coordination باید قابل‌ردیابی بماند.

برای انتخاب Actor نیز همین کافی است:

```text
Work + candidate Actors + optional hints + execution history + current observations
                              ↓
                            Rule
                              ↓
                         chosen Actor
```

Factory لازم نیست از ابتدا یک optimizer یا marketplace engine داشته باشد. Rule ساده می‌تواند مثلاً بگوید «بین Actorهای مناسب، گزینه ارزان‌تر و آزادتر را ترجیح بده» و بعداً با داده واقعی بهتر شود.


---

## 9. Control Surfaces و هدایت Factory

Factory لازم نیست برای هر تصمیم یک UI اختصاصی بسازد. ابزارهای موجود می‌توانند سطح کنترل انسانی باشند.

مثلاً:

```text
GitHub Issue created
      ↓
Event
      ↓
Rule
      ↓
Work created
```

یا:

```text
label added: approved
      ↓
Event
      ↓
Rule
      ↓
resume Work
```

یا:

```text
comment: /stop
      ↓
Event
      ↓
Rule
      ↓
pause/cancel Execution
```

این یعنی GitHub، Jira، Slack یا هر سیستم متصل می‌تواند **control surface** باشد، بدون اینکه خودش بخشی از Core شود.

قاعده:

> **Existing tools can act as control surfaces for the Factory.**

Factory فقط باید بداند چه Eventی رسید، Rule چه تصمیمی گرفت و چه Work/Executionی تحت‌تأثیر قرار گرفت.

### Operational command ≠ Factory behavior change

این دو باید جدا بمانند:

```text
Operational command
- approve this Work
- pause this Execution
- retry
- reassign
- resume
- stop
```

در برابر:

```text
Factory behavior change
- change watchdog policy
- change retry strategy
- install connector/plugin
- change permissions
- change scheduled jobs
- change how approvals work
```

اولی coordination جاری را تغییر می‌دهد؛ دومی خود Factory را تغییر می‌دهد.

---

## 10. Factory self-modification boundary

اینکه config/code مربوط به Factory کنار repo پروژه باشد می‌تواند مفید باشد:

```text
repo/
├── src/
├── tests/
├── docs/
└── .factory/
    ├── rules.yaml
    ├── actors.yaml
    └── jobs.yaml
```

مزیت آن این است که behavior Factory versioned، reviewable و قابل trace می‌شود.

اما co-location نباید authority را یکی کند. Actorی که اجازه تغییر `src/**` دارد، الزاماً نباید بتواند `.factory/**` را هم تغییر دهد.

قاعده اصلی:

> **The Factory may operate the project, but it must not silently rewrite the rules that govern itself.**

و:

> **Work on product ≠ Work on factory.**

هر دو می‌توانند Work باشند، اما Rules و authority متفاوت دارند.

مثال:

```text
Work: fix login bug
→ coding-agent
→ may run autonomously
```

در مقابل:

```text
Work: change watchdog restart policy
→ platform actor
→ require stronger approval
```

تغییر رفتار Factory بهتر است حداقل این مسیر را داشته باشد:

```text
propose change
   ↓
show diff
   ↓
required approval
   ↓
activate
```

این مسیر یک primitive جدید نیست؛ با Work، Event، Reference، Rule و Execution قابل بیان است.

---

## 11. Runtime / Extension vocabulary

برای implementation می‌توان vocabulary زیر را استفاده کرد، بدون اینکه Core بزرگ شود:

| مفهوم | معنی ساده | جایگاه |
|---|---|---|
| **Scheduled Job** | trigger زمانی/دوره‌ای که معمولاً Work می‌سازد | Rule/runtime |
| **Skill** | روش یا توانایی reusable برای انجام کار | Actor/runtime |
| **Tool** | action قابل فراخوانی توسط Actor | runtime |
| **Connector** | اتصال به سیستم بیرونی | boundary/adapter |
| **Plugin** | بسته‌ای برای افزودن capability/connector/tool/config | packaging |

این vocabulary برای Runtime/Extensions مفید است، اما Concept فقط اثر observable را نیاز دارد.

مثلاً:

```text
Scheduled Job
   ↓
Event
   ↓
Rule
   ↓
Work
```

یا:

```text
Actor uses Tool
   ↓
Execution produces external change
   ↓
Reference/Event
```

قاعده:

> **Extension vocabulary must not leak into Core unless it has an independent coordination identity.**

---

## 12. Factory Definition

حداقل تعریف Factory:

```text
Factory = Actors + Connections + Rules
```

نمونه:

```yaml
factory: payment-platform

actors:
  - backend-agent
  - sara
  - security-agent

connections:
  - github
  - jira
  - ci

rules:
  - on_bug_report_create_work
  - production_requires_human
```

هر چیز دیگری فقط وقتی اضافه می‌شود که use case واقعی آن را لازم کند.

---

## 13. ارزش اصلی: Cross-system lineage

مثال:

```text
Customer report
   ↓
Work
   ↓
Support Actor
   ↓
Execution
   ↓
GitHub issue
   ↓
Implementation Work
   ↓
Developer Actor
   ↓
PR
   ↓
CI
   ↓
Deployment
```

هر node ممکن است جای دیگری زندگی کند. Factory فقط connection بین آن‌ها را قابل‌ردیابی می‌کند.

```text
report ──triggered──> work
execution ──produced──> pr
pr ──verified-by──> ci-run
deployment ──derived-from──> pr
```

این lineage نباید نیازمند mirror کامل Jira/Git/Agent runtime باشد.

---

## 14. چند Factory

Concept جداگانه Federation لازم نیست. اگر Factory دیگری در جریان حضور دارد، از دید این Factory یک boundary بیرونی است.

```text
Factory A Work → Actor/endpoint in Factory B
```

اگر Work مستقل ایجاد شد، با Reference/Relation به Work قبلی وصل می‌شود. همین.

---

## 15. فقط دو boundary

برای فهم Concept دو لایه کافی است:

```text
┌──────────────────────────────┐
│ Software Factory             │
│ Work Actor Execution         │
│ Reference Relation Event     │
│ Rules                        │
└──────────────┬───────────────┘
               │
┌──────────────▼───────────────┐
│ External World               │
│ Git · Jira · CI · Agents     │
│ Chat · Runtime · Workflow    │
└──────────────────────────────┘
```

هر layering بیشتر، تصمیم implementation است نه Concept.

---

## 16. Invariants

1. Factory یک System of Coordination است، نه System of Record همه‌چیز.
2. Factory فقط چیزی را مدل می‌کند که برای coordination یا trace لازم است.
3. Actor از داخل opaque است؛ internal composition بدون coordination مستقیم مدل نمی‌شود.
4. Human و Agent از یک مسیر Actor استفاده می‌کنند.
5. Work با queue item، workflow step، assignment یا runtime session یکی نیست.
6. Execution یک attempt است؛ retry می‌تواند Execution جدید روی همان Work باشد.
7. External entityها تا جای ممکن با Reference نگه داشته می‌شوند.
8. Relation/Event history را به‌جای بازنویسی گذشته قابل‌ردیابی می‌کنند.
9. Protocol/vendor/runtime وارد Core نمی‌شوند.
10. timeout یا نبود پاسخ به معنی failure قطعی نیست.
11. Execution completed به معنی Work completed نیست.
12. هر abstraction جدید باید نیاز مشاهده‌پذیر و فعلی داشته باشد.
13. No topology unless Factory coordinates it.
14. No concept without an observable responsibility.
15. Prefer opaque boundaries over mirrored reality.
16. Prefer metadata/configuration over a new primitive.
17. Prefer deletion over future-proof abstraction.
18. cost/speed/quality/load بخشی از identity Actor نیستند.
19. hintهای Actor باید coarse، optional و قابل نادیده‌گرفتن باشند.
20. رفتار مشاهده‌شده در Execution history از hint اعلام‌شده معتبرتر است.
21. بدون نیاز واقعی، scoring/reputation/optimization subsystem ساخته نمی‌شود.
22. Running بودن process یا Actor به معنی progressing بودن Work نیست.
23. Execution می‌تواند observed، stalled، recovered یا retried شود بدون ساخت primitive جدید.
24. Orchestrator، watchdog، scheduler و supervisor mechanism هستند؛ Core به implementation آن‌ها وابسته نمی‌شود.
25. Recovery باید history قبلی را حفظ کند؛ retry واقعی Execution جدید است.
26. ابزارهای موجود می‌توانند control surface باشند؛ UI اختصاصی Factory اجباری نیست.
27. operational command با تغییر behavior خود Factory یکی نیست.
28. co-location فایل‌های Factory با repo پروژه به معنی permission یکسان نیست.
29. self-modification باید boundary و approval سخت‌تری از Work عادی داشته باشد.
30. scheduled job، skill، tool، connector و plugin vocabulary Runtime/Extension هستند، نه primitive Core.
31. تغییر behavior Factory باید به‌صورت Work/Event/Rule قابل trace باشد و silent mutation مجاز نیست.

---

## 17. Anti-patterns

- mirror کردن کامل Jira/Git/Slack داخل Factory
- مدل‌کردن topology داخلی Agent یا vendor بدون نیاز coordination
- ساخت `Team`, `Pod`, `CompositeActor`, `Seat` به‌عنوان primitive پایه
- branch کردن Core برای Human و Agent
- یکی گرفتن Work با task record یک ابزار
- ساخت Work جدید صرفاً به‌خاطر retry/handover/runtime change
- ساخت subsystem جدا برای هر policy vocabulary
- تبدیل هر مفهوم مهم UI به domain primitive
- future-proofing بدون use case واقعی
- مخفی‌کردن unknown با حدس‌زدن success/failure
- چسباندن cost/speed/quality ثابت و دقیق به Actor
- ساخت scoring engine قبل از وجود داده و نیاز واقعی
- یکی گرفتن self-declared capability/hint با performance واقعی
- تبدیل `Watchdog`, `Orchestrator`, `Scheduler` یا `Supervisor` به primitiveهای Core
- فرض اینکه process alive یعنی Work در حال پیشرفت است
- overwrite کردن Execution قبلی هنگام retry/recovery و از بین بردن history
- اجازه دادن به Actor معمولی برای تغییر silent فایل‌ها/Rulesی که خودش را govern می‌کنند
- یکی گرفتن permission کد پروژه با permission تغییر `.factory/**`
- ساخت UI اختصاصی برای controlهایی که GitHub/Jira/Slack به‌خوبی می‌توانند surface کنند
- تبدیل `Skill`, `Tool`, `Connector`, `Plugin` یا `ScheduledJob` به primitive Core صرفاً چون در Runtime مهم‌اند

---

## 18. Stress tests

| سناریو | رفتار مورد انتظار |
|---|---|
| یک Agent در واقع پشتش ۲۰ Agent و ۳ Human دارد | Factory فقط همان Actor بیرونی را می‌بیند. |
| Agent کار را به Human ادامه می‌دهد | Work حفظ می‌شود؛ Execution/Relation/Event history تغییر را نشان می‌دهد. |
| Webhook دوبار می‌رسد | deduplication در adapter؛ Work تکراری بی‌دلیل ساخته نمی‌شود. |
| deploy timeout می‌شود | وضعیت unknown می‌ماند تا بررسی شود. |
| Jira با Linear عوض می‌شود | Core نباید تغییر کند. |
| Agent runtime عوض می‌شود | Actor/Work identity نباید وابسته به runtime باشد. |
| یک workflow step خودش intent مستقل دارد | می‌تواند Work باشد؛ اگر فقط position است، Work جدید نیست. |
| Factory دیگری بخشی از کار را انجام می‌دهد | همان Actor/Reference/Relation کافی است. |
| یک قابلیت جدید فقط با primitive تازه قابل بیان به نظر می‌رسد | اول اثبات شود با metadata/Rule/Relation/Event قابل بیان نیست. |
| تیم محصول می‌گوید شاید سال بعد topology لازم شود | تا use case واقعی نیامده، اضافه نمی‌شود. |
| Agent برای bug fix ارزان و سریع ولی برای architecture ضعیف است | hint می‌تواند وابسته به context باشد؛ identity Actor تغییر نمی‌کند. |
| cost یا speed یک Actor با زمان تغییر می‌کند | profile ثابت بازنویسی نمی‌شود؛ history/observation جاری مبناست. |
| هنوز history کافی نداریم | از hintهای coarse اختیاری یا Rule ساده استفاده می‌شود؛ subsystem جدید ساخته نمی‌شود. |
| Agent process زنده است ولی مدت زیادی هیچ پیشرفتی ندارد | observation می‌تواند stall را ثبت کند؛ Rule تصمیم به صبر/recover/retry می‌گیرد؛ watchdog primitive جدید نیست. |
| Runtime قطع و دوباره وصل می‌شود | اگر همان attempt قابل ادامه است Execution حفظ می‌شود؛ اگر retry واقعی است Execution جدید ساخته می‌شود. |
| Watchdog با ابزار دیگری جایگزین می‌شود | Concept و Core تغییر نمی‌کنند. |
| Issue با label `approved` تایید می‌شود | label-change یک Event است؛ Rule می‌تواند Work را resume/start کند. |
| Human با comment می‌گوید فعلاً stop | command به Event تبدیل می‌شود؛ Rule execution جاری را pause/cancel می‌کند. |
| Agent می‌خواهد config watchdog را تغییر دهد | این Work روی Factory است و policy/approval سخت‌تری می‌خواهد؛ silent self-modification مجاز نیست. |
| `.factory/` داخل همان repo پروژه است | location مشترک permission مشترک ایجاد نمی‌کند. |
| Plugin جدید نصب می‌شود | Core تغییر نمی‌کند؛ فقط extension/runtime و اثر observable آن اضافه می‌شود. |
| Scheduled job هر شب dependency scan اجرا می‌کند | trigger زمانی → Event/Rule → Work؛ primitive جدید لازم نیست. |

---

## Final Mental Model

```text
                         SOFTWARE FACTORY

       Work ───────────────> Actor
        │                     │
        │                     ▼
        └──────────────> Execution
                              │
                 observations / progress
                              │
                     References / Events
                              │
                         Relations
                              │
                              ▼
                    External tools/systems
                    ↑            ↑
             control surfaces   extensions

           Execution history / observations
                    ↓                 ↓
              better routing      recovery rules
```

Factory قرار نیست جهان نرم‌افزار را مدل کند.

**فقط باید بتواند Work را میان Actorها و سیستم‌های موجود جلو ببرد و داستان آن را بعداً بازسازی کند.**

### معیار نهایی طراحی

اگر developer برای فهم Concept مجبور باشد topology داخلی Agent، lifecycle چندلایه Factory، taxonomy بزرگ governance یا مدل موازی ابزارهای بیرونی را یاد بگیرد، Concept بیش از حد پیچیده شده است.

نسخه مطلوب باید بتواند با کمترین مفاهیم به این پرسش‌ها پاسخ دهد:

```text
چه کاری وجود داشت؟
چه Actorی روی آن کار کرد؟
چه attemptهایی انجام شد؟
آیا attempt واقعاً پیشرفت کرد، stall شد یا recovery لازم داشت؟
چه چیزهایی در سیستم‌های بیرونی تولید یا تغییر کرد؟
کدام control surface یا Rule مسیر را تغییر داد؟
آیا تغییری روی خود Factory انجام شد و با چه authority؟
این اتفاق‌ها چگونه به هم مربوط بودند؟
بعد چه شد؟
```

اگر این زنجیره قابل پاسخ است، Factory کار اصلی خود را انجام داده است.
