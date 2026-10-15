-- Rollback 001_initial_schema: drop all created objects in dependency order.

DROP TABLE IF EXISTS "relations";
DROP TABLE IF EXISTS "references";
DROP TABLE IF EXISTS artifacts;
DROP TABLE IF EXISTS budget_ledger;
DROP TABLE IF EXISTS external_effects;
DROP TABLE IF EXISTS approvals;
DROP TABLE IF EXISTS worker_leases;
DROP TABLE IF EXISTS agent_runs;
DROP TABLE IF EXISTS idempotency_keys;
DROP TABLE IF EXISTS outbox;
DROP TABLE IF EXISTS events;
DROP TABLE IF EXISTS executions;
DROP TABLE IF EXISTS works;
DROP TABLE IF EXISTS projects;
DROP TABLE IF EXISTS actors;
DROP TABLE IF EXISTS tenants;