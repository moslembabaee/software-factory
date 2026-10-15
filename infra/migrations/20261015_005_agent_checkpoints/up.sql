-- Agent context is an implementation projection of Work/Execution, not a core primitive.
CREATE TABLE agent_checkpoints (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  work_id uuid NOT NULL,
  execution_id uuid NOT NULL,
  sequence bigint NOT NULL CHECK (sequence > 0),
  step integer NOT NULL CHECK (step >= 0),
  worker_id text NOT NULL CHECK (length(worker_id) BETWEEN 1 AND 200),
  fence bigint NOT NULL CHECK (fence > 0),
  context jsonb NOT NULL CHECK (jsonb_typeof(context) = 'object'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (tenant_id, execution_id, sequence),
  UNIQUE (tenant_id, execution_id, id),
  FOREIGN KEY (tenant_id, execution_id, work_id) REFERENCES executions(tenant_id, id, work_id)
);
CREATE INDEX agent_checkpoints_by_work ON agent_checkpoints(tenant_id, work_id, created_at, id);

-- A recovery gets a new Execution; never erase the timed-out attempt's history.
CREATE TABLE agent_recoveries (
  tenant_id uuid NOT NULL,
  source_execution_id uuid NOT NULL,
  execution_id uuid NOT NULL,
  checkpoint_id uuid NOT NULL,
  PRIMARY KEY (tenant_id, source_execution_id),
  UNIQUE (tenant_id, execution_id),
  FOREIGN KEY (tenant_id, source_execution_id, checkpoint_id)
    REFERENCES agent_checkpoints(tenant_id, execution_id, id),
  FOREIGN KEY (tenant_id, execution_id) REFERENCES executions(tenant_id, id),
  CHECK (source_execution_id <> execution_id)
);

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['agent_checkpoints', 'agent_recoveries'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid) WITH CHECK (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid)', table_name
    );
  END LOOP;
END $$;

CREATE FUNCTION prevent_agent_context_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Agent context history is immutable' USING ERRCODE = '42501';
END $$;
CREATE TRIGGER agent_checkpoints_append_only BEFORE UPDATE OR DELETE ON agent_checkpoints
  FOR EACH ROW EXECUTE FUNCTION prevent_agent_context_mutation();
CREATE TRIGGER agent_recoveries_append_only BEFORE UPDATE OR DELETE ON agent_recoveries
  FOR EACH ROW EXECUTE FUNCTION prevent_agent_context_mutation();
