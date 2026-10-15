# v6.3 consumer-first full-build authority
Read 49–53 immediately after 37 and 43–48. All capabilities remain mandatory; consumer experience contracts are additive and binding. Security and authorization invariants override convenience. Source docs 01–36 and 99 remain in scope; earlier MVP/phase labels do not remove features.

# v6.2 authoritative reading order
Read 37, 43, 44, 45, 46, 47, 48, then 38–42, 31–36, 01–30 and 99. All capabilities mandatory; older phase labels nonbinding. 46 and 45 are reference baselines, not exhaustive executable implementation artifacts.

# Software Factory — Unified Build Pack v6.1 (full-build amendment)

**Product:** Software Factory  
**Status:** implementation-ready documentation baseline (software not yet implemented)  
**Sources:** Software Factory V5 build pack + autonomous coding agent specification suite.

**Mandatory amendment:** Read `37_FULL_BUILD_MANDATE.md` first. It replaces MVP/optional/future-scope exclusions; all source capabilities remain in final build. See 38–42 for binding clarifications and acceptance.

## Start here
1. Read `37_FULL_BUILD_MANDATE.md`, `38_DECISIONS_AND_CONTRACT_CLARIFICATIONS.md`, and `39_FULL_ACCEPTANCE_MATRIX.md`.
2. Read `31_INTEGRATED_SYSTEM_ARCHITECTURE.md` for boundaries and invariants.
3. Read `33_API_EVENTS_AND_STORAGE_CONTRACTS.md` for versioned interfaces.
4. Read `32_AGENT_RUNTIME_AND_CONTEXT.md` for the autonomous coding runtime.
5. Read `34_SECURITY_SANDBOX_AND_APPROVALS.md` before any tool execution.
6. Implement the entire documented product; dependency order is internal only, not a scope reduction.
7. Track decisions in `36_ADR_DECISIONS_AND_TRACEABILITY.md`.

## Document authority
Documents 37–42 supersede conflicting details in 31–36 and 01–30; documents 31–36 supersede overlapping implementation details in 00–30; documents 01–30 remain the detailed Factory product and UX source. Existing concepts and the six core primitives are preserved. Changes to original documents are marked as integrated v6 extensions.

## Scope and limitations
This package provides design contracts, phase gates and test requirements; it does **not** include running services, executable migrations or verified deployment. Technology selections and production SLOs still require explicit decisions. The agent source specification is treated as architectural inspiration, not proof of vendor behavior.

## Contents
- [00_START_HERE.md](00_START_HERE.md)
- [01_PRODUCT_AND_WORKBENCH_v1.md](01_PRODUCT_AND_WORKBENCH_v1.md)
- [02_RUNTIME_ARCHITECTURE_v2.md](02_RUNTIME_ARCHITECTURE_v2.md)
- [03_FLOW_AND_SUBFLOW_v1.md](03_FLOW_AND_SUBFLOW_v1.md)
- [04_CONVERSATIONAL_INTAKE_v1.md](04_CONVERSATIONAL_INTAKE_v1.md)
- [05_DISTRIBUTED_WORKERS_AND_SANDBOX_v1.md](05_DISTRIBUTED_WORKERS_AND_SANDBOX_v1.md)
- [06_DOMAIN_AND_STORAGE_v2.md](06_DOMAIN_AND_STORAGE_v2.md)
- [07_API_AND_EVENT_CONTRACTS_v1.md](07_API_AND_EVENT_CONTRACTS_v1.md)
- [08_CONTROL_AND_SELF_MODIFICATION_v2.md](08_CONTROL_AND_SELF_MODIFICATION_v2.md)
- [09_OBSERVABILITY_AND_LINEAGE_v2.md](09_OBSERVABILITY_AND_LINEAGE_v2.md)
- [10_EXTENSION_MODEL_v2.md](10_EXTENSION_MODEL_v2.md)
- [11_MVP_SCOPE_v2.md](11_MVP_SCOPE_v2.md)
- [12_IMPLEMENTATION_ROADMAP_v2.md](12_IMPLEMENTATION_ROADMAP_v2.md)
- [13_REPOSITORY_LAYOUT_v1.md](13_REPOSITORY_LAYOUT_v1.md)
- [14_ADR_BASELINE_v2.md](14_ADR_BASELINE_v2.md)
- [15_RELIABILITY_AND_RECOVERY_v1.md](15_RELIABILITY_AND_RECOVERY_v1.md)
- [16_SECURITY_AND_APPROVAL_v1.md](16_SECURITY_AND_APPROVAL_v1.md)
- [17_ARCHITECTURE_ACCEPTANCE_TESTS_v1.md](17_ARCHITECTURE_ACCEPTANCE_TESTS_v1.md)
- [18_DECISIONS_AND_RISKS_v1.md](18_DECISIONS_AND_RISKS_v1.md)
- [19_USER_JOURNEYS_v1.md](19_USER_JOURNEYS_v1.md)
- [20_PROJECT_WORKSPACE_AND_MODES_v1.md](20_PROJECT_WORKSPACE_AND_MODES_v1.md)
- [21_PREVIEW_ACCEPTANCE_AND_DELIVERY_v1.md](21_PREVIEW_ACCEPTANCE_AND_DELIVERY_v1.md)
- [22_FEEDBACK_AND_CHANGE_MANAGEMENT_v1.md](22_FEEDBACK_AND_CHANGE_MANAGEMENT_v1.md)
- [23_BUDGET_AUTONOMY_AND_APPROVAL_UX_v1.md](23_BUDGET_AUTONOMY_AND_APPROVAL_UX_v1.md)
- [24_ONBOARDING_AND_USABILITY_ACCEPTANCE_v1.md](24_ONBOARDING_AND_USABILITY_ACCEPTANCE_v1.md)
- [25_UX_API_PROJECTIONS_AND_PHASES_v1.md](25_UX_API_PROJECTIONS_AND_PHASES_v1.md)
- [26_UNIFIED_WEB_WORKSPACE_AND_NAVIGATION_v1.md](26_UNIFIED_WEB_WORKSPACE_AND_NAVIGATION_v1.md)
- [27_ASK_BUILD_CHAT_INTERACTION_CONTRACT_v1.md](27_ASK_BUILD_CHAT_INTERACTION_CONTRACT_v1.md)
- [28_CHAT_TO_CONFIGURATION_AND_SETTINGS_v1.md](28_CHAT_TO_CONFIGURATION_AND_SETTINGS_v1.md)
- [29_WORKSPACE_UI_ACCEPTANCE_TESTS_v1.md](29_WORKSPACE_UI_ACCEPTANCE_TESTS_v1.md)
- [30_UI_DELIVERY_PHASES_AND_OPEN_DECISIONS_v1.md](30_UI_DELIVERY_PHASES_AND_OPEN_DECISIONS_v1.md)
- [31_INTEGRATED_SYSTEM_ARCHITECTURE.md](31_INTEGRATED_SYSTEM_ARCHITECTURE.md)
- [32_AGENT_RUNTIME_AND_CONTEXT.md](32_AGENT_RUNTIME_AND_CONTEXT.md)
- [33_API_EVENTS_AND_STORAGE_CONTRACTS.md](33_API_EVENTS_AND_STORAGE_CONTRACTS.md)
- [34_SECURITY_SANDBOX_AND_APPROVALS.md](34_SECURITY_SANDBOX_AND_APPROVALS.md)
- [35_BUILD_PLAN_AND_ACCEPTANCE.md](35_BUILD_PLAN_AND_ACCEPTANCE.md)
- [36_ADR_DECISIONS_AND_TRACEABILITY.md](36_ADR_DECISIONS_AND_TRACEABILITY.md)
- [99_SOFTWARE_FACTORY_CONCEPT_v54.md](99_SOFTWARE_FACTORY_CONCEPT_v54.md)

## Full-build amendments
- [37_FULL_BUILD_MANDATE.md](37_FULL_BUILD_MANDATE.md)
- [38_DECISIONS_AND_CONTRACT_CLARIFICATIONS.md](38_DECISIONS_AND_CONTRACT_CLARIFICATIONS.md)
- [39_FULL_ACCEPTANCE_MATRIX.md](39_FULL_ACCEPTANCE_MATRIX.md)
- [40_AGENT_HANDOFF_PROMPT.md](40_AGENT_HANDOFF_PROMPT.md)
- [41_API_CONTRACT_GAPS.md](41_API_CONTRACT_GAPS.md)
- [42_RISK_AND_OPEN_DECISION_REGISTER.md](42_RISK_AND_OPEN_DECISION_REGISTER.md)


## v6.4 binding consumer addendum
Read 54–57 and the revised 46 OpenAPI before implementing consumer features. Where older consumer prose differs, these machine-readable contracts and v6.4 policy govern.


## v6.5 mandatory release addendum
Read docs 58-61 before implementation. A complete one-shot agent build requires executable evidence, not only document compliance.
