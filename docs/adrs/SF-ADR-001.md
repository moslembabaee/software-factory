# SF-ADR-001 — TypeScript Strict, Node LTS, React UI with One Shared Generated Contract Package

- **Status:** Accepted
- **Date:** Phase 0 baseline
- **Source of record:** docs/43_BINDING_ADRS_AND_DECISION_POLICY.md (binding, v6.2)

## Context

The full build spans web UI, API, scheduler, workers and shared contracts. Historically the platform was language- and queue-agnostic by design (LEGACY36-OD-01 left backend/frontend language selection open). A fresh full build needs one coherent baseline so type safety, tooling and developer experience are uniform across all runtime components, and so web, API, scheduler, workers and contracts cannot drift into incompatible representations of the same domain.

## Decision

Adopt **TypeScript strict** for web, API, scheduler, workers and contracts; run on **Node LTS**; use **React** for the UI. All type definitions shared across components are generated into **one shared generated contract package** consumed by every TypeScript component.

**Invariant (normative):** One shared generated contract package.

## Consequences

- Type errors across component boundaries are caught at compile time rather than at runtime.
- The shared generated contract package is the single source of truth for inter-component shapes; no component may hand-maintain its own divergent copy.
- Node LTS bounds the runtime surface to a stable, supported release line.
- React UI is consistent with the TypeScript baseline and consumes the same generated contracts as the API.
- Changes to shared contracts must be made in the generator source and regenerated; CI must reject unregenerated drift.