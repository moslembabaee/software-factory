# Repository Layout v1

Suggested monorepo layout:

```text
software-factory/
├── apps/
│   ├── api/
│   └── workbench/
│
├── packages/
│   ├── domain/
│   ├── runtime/
│   ├── flow/
│   ├── events/
│   ├── storage/
│   ├── actor-adapters/
│   ├── connectors/
│   └── worker-sdk/
│
├── workers/
│   └── local-worker/
│
├── .factory/
│   ├── flows/
│   ├── rules/
│   ├── actors/
│   ├── jobs/
│   ├── skills/
│   └── policies/
│
├── migrations/
├── tests/
├── docs/
└── README.md
```

---

## Dependency rule

```text
domain
↑
runtime / flow / storage
↑
api / workers / connectors
↑
workbench
```

Domain must not import:

- GitHub SDK
- Codex SDK
- Docker client
- workflow runtime
- UI code

---

## `.factory/**`

Version-controlled behavior/config.

Write protection is policy, not filesystem assumption only.

---

## Worker SDK

Worker implementation should only need:

```text
register
heartbeat
start execution
observe
cancel
cleanup
```

---

## First implementation recommendation

Start monolithic for control-plane:

```text
api + runtime + flow + storage
```

Keep Worker as separate process early because distributed execution is a known requirement.


## Additional packages (v6)

Add `apps/agent-worker`, `packages/agent-runtime`, `packages/tool-gateway`, `packages/context-manager`, `packages/policy-engine`, `packages/contracts`, `packages/event-projections`, and `infra/sandbox`; exact initial scaffold and ownership are in `35_BUILD_PLAN_AND_ACCEPTANCE.md`.
