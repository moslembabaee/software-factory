# v6.4 changes and residual gaps

- Added consumer API operations to canonical `46_OPENAPI_BASELINE.yaml`, with request/response schemas and structured errors.
- Added PostgreSQL consumer tables and RLS policies in `54_CONSUMER_STORAGE_MIGRATION.sql`. This is an additive migration applied after 45.
- Added state transition, version-binding, idempotency and safe-error policy in 55.
- Added deterministic acceptance scenario specification in 56.
- Updated manifest and API versions to 6.4.

## Remaining engineering requirements (not silently considered solved)
- The baseline OpenAPI still does not cover every non-consumer API family listed in 47; generate and validate complete coverage before implementation acceptance.
- No deployed runtime, actual browser tests, database migration execution, or security penetration tests are provided in this specification bundle.
- Service-level transaction locks, append-only enforcement, RLS for older baseline tables, object-store encryption and signed artifact verification remain implementation work.
- Acceptance scenarios are precise specifications, not runnable pytest/Playwright files because there is no application server or test harness in this archive.
