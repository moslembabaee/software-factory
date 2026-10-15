-- Keep the canonical initial migration immutable. Missing context denies access.
DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'actors', 'projects', 'works', 'executions', 'events', 'idempotency_keys',
    'agent_runs', 'worker_leases', 'approvals', 'external_effects',
    'budget_ledger', 'artifacts', 'references', 'relations'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid) WITH CHECK (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid)',
      table_name
    );
  END LOOP;
END $$;

ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenants FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON tenants
  USING (id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- Outbox has no tenant_id; inherit isolation through its immutable event.
ALTER TABLE outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE outbox FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON outbox
  USING (EXISTS (SELECT 1 FROM events WHERE events.id = outbox.event_id))
  WITH CHECK (EXISTS (SELECT 1 FROM events WHERE events.id = outbox.event_id));

-- Single-column FKs alone permit references to actors in another tenant.
ALTER TABLE actors ADD CONSTRAINT actors_tenant_id_id_key UNIQUE (tenant_id, id);
ALTER TABLE works ADD CONSTRAINT works_tenant_creator_fkey
  FOREIGN KEY (tenant_id, created_by) REFERENCES actors(tenant_id, id);
ALTER TABLE idempotency_keys ADD CONSTRAINT idempotency_tenant_actor_fkey
  FOREIGN KEY (tenant_id, actor_id) REFERENCES actors(tenant_id, id);
ALTER TABLE approvals ADD CONSTRAINT approvals_tenant_reviewer_fkey
  FOREIGN KEY (tenant_id, reviewer_id) REFERENCES actors(tenant_id, id);

CREATE FUNCTION prevent_history_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = 'events' THEN
    RAISE EXCEPTION 'History is immutable' USING ERRCODE = '42501';
  END IF;
  IF OLD.kind = 'settle' THEN
    RAISE EXCEPTION 'History is immutable' USING ERRCODE = '42501';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER events_append_only BEFORE UPDATE OR DELETE ON events
  FOR EACH ROW EXECUTE FUNCTION prevent_history_mutation();
CREATE TRIGGER settled_ledger_immutable BEFORE UPDATE OR DELETE ON budget_ledger
  FOR EACH ROW EXECUTE FUNCTION prevent_history_mutation();
