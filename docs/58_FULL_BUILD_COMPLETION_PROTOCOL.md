# Full-build completion protocol — v6.5 (normative)

## Scope
Implement every capability in docs 01–57, including MCP, subagents, ACP, self-modification controls, consumer previews, visual feedback, history, budget, recovery, and delivery. Historical MVP/optional/future wording is non-binding and must not be used to omit features. A single agent assignment may complete all work; internal dependency ordering and iterative tests are mandatory.

## Evidence-driven completion
The agent MUST generate `coverage/capabilities.csv` with columns `id,source_doc,requirement,ui_route,api_operation,schema_object,implementation_path,test_path,test_result,evidence_uri`. Each normative feature must have a row; no blank implementation or test fields at final handoff. Any intentionally unsupported requirement is a blocker requiring explicit owner decision, never silently marked complete.

Generate `coverage/api-operations.csv` for all endpoints in docs 07, 25, 33, 47, 53; reconcile against canonical OpenAPI. Fail if any documented endpoint lacks an operationId, request/response schema, authorization rules, error shape and contract test. A baseline OpenAPI file is not evidence of full coverage.

## Release gates
G1: all source requirements traced; G2: OpenAPI lint and response/request contract tests; G3: SQL migrations from clean DB and upgrade path; G4: auth/RLS tenant isolation tests; G5: execution state transition and concurrent race tests; G6: idempotent recovery after injected failures; G7: sandbox negative security tests; G8: budget stop under parallel agents; G9: consumer E2E preview-feedback-revision-acceptance-delivery; G10: deployment/rollback and ownership export. Each gate has a command, environment, artifacts, and pass/fail in `release/evidence.json`.

## Release outcome
Only `READY` if every gate passes in the actual implementation environment. Otherwise `BLOCKED`, list failed gates and reproducible commands. Never assert tests passed when only specification files were validated. An agent may run continuously, but must not bypass human approval for irreversible, externally billable or privileged actions.
