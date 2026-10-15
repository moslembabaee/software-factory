# Extension Model v2

---

## 1. Vocabulary

### Scheduled Job

Time/recurrence trigger:

```text
schedule → Event → Rule/Flow → Work
```

### Skill

Reusable instructions/procedure for Actor.

### Tool

Action available to Actor/runtime.

### Connector

Boundary to external system.

### Plugin

Packaging unit that may bundle the above.

---

## 2. Important rule

None are Core primitives.

---

## 3. Suggested filesystem

```text
.factory/
  flows/
  rules/
  actors/
  jobs/
  skills/
  connectors/
```

Application code may provide implementation packages:

```text
runtime/
  adapters/
  connectors/
  workers/
```

---

## 4. Skill example

```yaml
id: impact-analysis
instructions_ref: skills/impact-analysis.md
verification:
  require:
    - affected_components
    - prerequisites
```

---

## 5. Scheduled Job example

```yaml
id: stale-work-check
schedule: "*/15 * * * *"
emit:
  event: maintenance.stale-work-check
```

---

## 6. Plugin abstraction

Do not build in MVP.

Introduce only when:

- install/uninstall becomes real use case
- distribution/versioning is needed
- multiple extensions are repeatedly bundled
