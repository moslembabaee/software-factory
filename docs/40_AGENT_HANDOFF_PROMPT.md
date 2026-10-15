> **v6.2:** Follow binding decisions and test oracle in 43–48; implement all capability rows in 47, expand baseline API 46 and schema 45, do not claim full coverage until verified.

# Agent handoff — copy as the top-level build instruction

Build the complete Software Factory described by this package in one continuous assignment. Read `docs/00_START_HERE.md` and `docs/37_FULL_BUILD_MANDATE.md` first, then all normative documents and product/UX sources. Do not scope-reduce to MVP or treat future/optional wording as exclusion. Follow precedence in 37. Resolve ambiguous non-product implementation choices with documented secure defaults in 38; escalate only genuinely external or irreversible decisions. Implement all backend, frontend, worker, agent, integration, security, reliability and observability capabilities with working code and tests. Keep a traceability ledger for every documented feature and acceptance gate. Never fabricate test results or call mocks production integrations. Enforce approval and sandbox boundaries even if doing so blocks an operation. Provide runnable setup, test commands, migrations, CI, evidence and explicit blocked items. Stop only when full acceptance gates in 39 pass or when remaining blockers are precisely documented with reproducible evidence.


## v6.3 binding consumer addendum
Before claiming complete, implement and prove CX-01 through CX-16 from 52, including real preview and end-user journey evidence.


## v6.5 mandatory handoff
Implement the entire product. Follow docs 58-61. Report BLOCKED unless all release gates have executed and passed. Do not treat specification validation as runtime acceptance.
