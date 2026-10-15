-- 002_rls_and_indexes.sql
-- Phase 1: Row-Level Security, immutable events trigger, additional indexes.
-- Apply AFTER 001_initial_schema.sql, BEFORE any data. PostgreSQL 16+.
--
-- Tenant model (SF-ADR-005): tenant_id is always derived server-side and is
-- never client-supplied. Sessions carry it in the `app.current_tenant` custom
-- GUC (set via set_config / connection options). RLS is deny-by-default: when
-- the variable is unset, current_setting returns NULL and every policy
-- evaluates to NULL (no rows). FORCE ROW LEVEL SECURITY is applied so even
-- superuser/owner sessions honor the policies.

-- ── Immutable events/outbox (SF-ADR-002, SF-ADR-007) ─────────────────────
-- Events are append-only; corrections are new events. Outbox rows are written
-- in the same transaction as the state change they record.
CREATE OR REPLACE FUNCTION reject_event_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'events and outbox are immutable (SF-ADR-002/007)'
    USING HINT = 'Append a new event; corrections require compensation events.';
END;
$$;

CREATE TRIGGER events_immutable
  BEFORE UPDATE OR DELETE ON events
  FOR EACH ROW EXECUTE FUNCTION reject_event_mutation();

CREATE TRIGGER outbox_immutable
  BEFORE UPDATE OR DELETE ON outbox
  FOR EACH ROW EXECUTE FUNCTION reject_event_mutation();

-- ── RLS tenant policies ──────────────────────────────────────────────────
-- Deny by default: `tenant_id = current_setting(...)::uuid` yields NULL when
-- the GUC is unset, so no rows are visible/insertable.

-- tenants: rows are provisioned by operators; app sessions only read their own.
ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenants_select ON tenants FOR SELECT
  USING (id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);

-- actors
ALTER TABLE actors ENABLE ROW LEVEL SECURITY;
CREATE POLICY actors_select ON actors FOR SELECT
  USING (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);
CREATE POLICY actors_insert ON actors FOR INSERT
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);
CREATE POLICY actors_update ON actors FOR UPDATE
  USING (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);
CREATE POLICY actors_delete ON actors FOR DELETE
  USING (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);

-- projects
ALTER TABLE projects ENABLE ROW LEVEL SECURITY;
CREATE POLICY projects_select ON projects FOR SELECT
  USING (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);
CREATE POLICY projects_insert ON projects FOR INSERT
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);
CREATE POLICY projects_update ON projects FOR UPDATE
  USING (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);
CREATE POLICY projects_delete ON projects FOR DELETE
  USING (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);

-- works
ALTER TABLE works ENABLE ROW LEVEL SECURITY;
CREATE POLICY works_select ON works FOR SELECT
  USING (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);
CREATE POLICY works_insert ON works FOR INSERT
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);
CREATE POLICY works_update ON works FOR UPDATE
  USING (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);
CREATE POLICY works_delete ON works FOR DELETE
  USING (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);

-- executions
ALTER TABLE executions ENABLE ROW LEVEL SECURITY;
CREATE POLICY executions_select ON executions FOR SELECT
  USING (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);
CREATE POLICY executions_insert ON executions FOR INSERT
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);
CREATE POLICY executions_update ON executions FOR UPDATE
  USING (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);
CREATE POLICY executions_delete ON executions FOR DELETE
  USING (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);

-- events (append-only: INSERT allowed, UPDATE/DELETE blocked by trigger)
ALTER TABLE events ENABLE ROW LEVEL SECURITY;
CREATE POLICY events_select ON events FOR SELECT
  USING (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);
CREATE POLICY events_insert ON events FOR INSERT
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);

-- outbox (append-only; published_at is left NULL until a future dispatcher
-- with dedicated privileges is introduced)
ALTER TABLE outbox ENABLE ROW LEVEL SECURITY;
CREATE POLICY outbox_select ON outbox FOR SELECT
  USING (event_id IN (SELECT id FROM events
                      WHERE tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid));
CREATE POLICY outbox_insert ON outbox FOR INSERT
  WITH CHECK (event_id IN (SELECT id FROM events
                           WHERE tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid));

-- idempotency_keys
ALTER TABLE idempotency_keys ENABLE ROW LEVEL SECURITY;
CREATE POLICY idempotency_keys_select ON idempotency_keys FOR SELECT
  USING (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);
CREATE POLICY idempotency_keys_insert ON idempotency_keys FOR INSERT
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);
CREATE POLICY idempotency_keys_update ON idempotency_keys FOR UPDATE
  USING (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);
CREATE POLICY idempotency_keys_delete ON idempotency_keys FOR DELETE
  USING (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);

-- agent_runs
ALTER TABLE agent_runs ENABLE ROW LEVEL SECURITY;
CREATE POLICY agent_runs_select ON agent_runs FOR SELECT
  USING (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);
CREATE POLICY agent_runs_insert ON agent_runs FOR INSERT
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);
CREATE POLICY agent_runs_update ON agent_runs FOR UPDATE
  USING (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);
CREATE POLICY agent_runs_delete ON agent_runs FOR DELETE
  USING (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);

-- approvals
ALTER TABLE approvals ENABLE ROW LEVEL SECURITY;
CREATE POLICY approvals_select ON approvals FOR SELECT
  USING (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);
CREATE POLICY approvals_insert ON approvals FOR INSERT
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);
CREATE POLICY approvals_update ON approvals FOR UPDATE
  USING (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);
CREATE POLICY approvals_delete ON approvals FOR DELETE
  USING (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);

-- budget_ledger (SELECT + INSERT only; settled rows are immutable, SF-ADR-002)
ALTER TABLE budget_ledger ENABLE ROW LEVEL SECURITY;
CREATE POLICY budget_ledger_select ON budget_ledger FOR SELECT
  USING (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);
CREATE POLICY budget_ledger_insert ON budget_ledger FOR INSERT
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);

-- artifacts
ALTER TABLE artifacts ENABLE ROW LEVEL SECURITY;
CREATE POLICY artifacts_select ON artifacts FOR SELECT
  USING (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);
CREATE POLICY artifacts_insert ON artifacts FOR INSERT
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);
CREATE POLICY artifacts_update ON artifacts FOR UPDATE
  USING (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);
CREATE POLICY artifacts_delete ON artifacts FOR DELETE
  USING (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);

-- worker_leases
ALTER TABLE worker_leases ENABLE ROW LEVEL SECURITY;
CREATE POLICY worker_leases_select ON worker_leases FOR SELECT
  USING (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);
CREATE POLICY worker_leases_insert ON worker_leases FOR INSERT
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);
CREATE POLICY worker_leases_update ON worker_leases FOR UPDATE
  USING (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);
CREATE POLICY worker_leases_delete ON worker_leases FOR DELETE
  USING (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);

-- external_effects
ALTER TABLE external_effects ENABLE ROW LEVEL SECURITY;
CREATE POLICY external_effects_select ON external_effects FOR SELECT
  USING (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);
CREATE POLICY external_effects_insert ON external_effects FOR INSERT
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);
CREATE POLICY external_effects_update ON external_effects FOR UPDATE
  USING (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);

-- references & relations (quoted: `references` is a reserved word)
ALTER TABLE "references" ENABLE ROW LEVEL SECURITY;
CREATE POLICY references_select ON "references" FOR SELECT
  USING (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);
CREATE POLICY references_insert ON "references" FOR INSERT
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);
CREATE POLICY references_update ON "references" FOR UPDATE
  USING (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);
CREATE POLICY references_delete ON "references" FOR DELETE
  USING (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);

ALTER TABLE "relations" ENABLE ROW LEVEL SECURITY;
CREATE POLICY relations_select ON "relations" FOR SELECT
  USING (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);
CREATE POLICY relations_insert ON "relations" FOR INSERT
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);
CREATE POLICY relations_update ON "relations" FOR UPDATE
  USING (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);
CREATE POLICY relations_delete ON "relations" FOR DELETE
  USING (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);

-- ── Additional indexes ───────────────────────────────────────────────────
CREATE INDEX works_tenant_state ON works(tenant_id, state);
CREATE INDEX executions_tenant_state ON executions(tenant_id, state);
CREATE INDEX idempotency_keys_lookup ON idempotency_keys(tenant_id, actor_id, route, key);
CREATE INDEX approvals_tenant_state ON approvals(tenant_id, decision);
CREATE INDEX budget_ledger_exec ON budget_ledger(tenant_id, execution_id);
CREATE INDEX artifacts_exec ON artifacts(tenant_id, execution_id);

-- ── Force RLS (applies policies to owner/superuser sessions too) ─────────
ALTER TABLE tenants FORCE ROW LEVEL SECURITY;
ALTER TABLE actors FORCE ROW LEVEL SECURITY;
ALTER TABLE projects FORCE ROW LEVEL SECURITY;
ALTER TABLE works FORCE ROW LEVEL SECURITY;
ALTER TABLE executions FORCE ROW LEVEL SECURITY;
ALTER TABLE events FORCE ROW LEVEL SECURITY;
ALTER TABLE outbox FORCE ROW LEVEL SECURITY;
ALTER TABLE idempotency_keys FORCE ROW LEVEL SECURITY;
ALTER TABLE agent_runs FORCE ROW LEVEL SECURITY;
ALTER TABLE worker_leases FORCE ROW LEVEL SECURITY;
ALTER TABLE approvals FORCE ROW LEVEL SECURITY;
ALTER TABLE external_effects FORCE ROW LEVEL SECURITY;
ALTER TABLE budget_ledger FORCE ROW LEVEL SECURITY;
ALTER TABLE artifacts FORCE ROW LEVEL SECURITY;
ALTER TABLE "references" FORCE ROW LEVEL SECURITY;
ALTER TABLE "relations" FORCE ROW LEVEL SECURITY;