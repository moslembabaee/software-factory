# Preview, Acceptance & Delivery v1 — normative
## Preview contract
Preview is an artifact with immutable build id, commit SHA, environment, timestamp, expiration, URL if available, and health status. Never claim a preview exists until verified reachable. Preview must isolate untrusted code and avoid production secrets; authenticated preview requires access controls.

## Acceptance contract
Execution success != verification success != feature acceptance != delivery success. Every feature has human-readable acceptance criteria, linked tests, evidence and reviewer decision. Only authorized reviewer can accept. Changes after acceptance create a new revision and do not silently overwrite accepted baseline.

## Delivery types
Supported: source repository/PR, runnable local build, preview URL, installable artifact, deployed service. Explicitly state supported type per stack and phase; deployment is not implied. Show exact version, test evidence, known limitations, setup, rollback options, credentials handoff process and ownership.

## Exit / portability
Provide export of source, documentation, plan, decisions and build metadata in documented formats. Never trap user in proprietary Work identifiers; provide mappings. Secrets are never included in exports by default.

## Negative paths
Broken preview -> not ready; tests passing but criteria unmet -> not accepted; deployment failure -> delivery failed without reverting acceptance automatically; non-reversible external operations require warning.
