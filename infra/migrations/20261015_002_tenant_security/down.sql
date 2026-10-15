DROP TRIGGER settled_ledger_immutable ON budget_ledger;
DROP TRIGGER events_append_only ON events;
DROP FUNCTION prevent_history_mutation();
ALTER TABLE approvals DROP CONSTRAINT approvals_tenant_reviewer_fkey;
ALTER TABLE idempotency_keys DROP CONSTRAINT idempotency_tenant_actor_fkey;
ALTER TABLE works DROP CONSTRAINT works_tenant_creator_fkey;
ALTER TABLE actors DROP CONSTRAINT actors_tenant_id_id_key;
DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'tenants', 'actors', 'projects', 'works', 'executions', 'events', 'outbox',
    'idempotency_keys', 'agent_runs', 'worker_leases', 'approvals',
    'external_effects', 'budget_ledger', 'artifacts', 'references', 'relations'
  ] LOOP
    EXECUTE format('DROP POLICY tenant_isolation ON %I', table_name);
    EXECUTE format('ALTER TABLE %I NO FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I DISABLE ROW LEVEL SECURITY', table_name);
  END LOOP;
END $$;
