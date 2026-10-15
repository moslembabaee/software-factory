-- One dispatch per Execution; retries after uncertain effects require reconciliation
-- and a new Execution, rather than silently replaying the same execution.
ALTER TABLE executions ADD CONSTRAINT executions_tenant_id_id_work_id_key
  UNIQUE (tenant_id, id, work_id);
CREATE TABLE work_queue (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  work_id uuid NOT NULL,
  execution_id uuid NOT NULL,
  priority integer NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'leased', 'acknowledged', 'timed_out', 'cancelled')),
  worker_id text,
  fence bigint NOT NULL DEFAULT 0 CHECK (fence >= 0),
  execution_version bigint NOT NULL CHECK (execution_version >= 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz,
  UNIQUE (tenant_id, execution_id),
  FOREIGN KEY (tenant_id, work_id) REFERENCES works(tenant_id, id),
  FOREIGN KEY (tenant_id, execution_id, work_id)
    REFERENCES executions(tenant_id, id, work_id),
  CHECK ((status = 'leased') = (expires_at IS NOT NULL)),
  CHECK (status <> 'leased' OR (worker_id IS NOT NULL AND length(worker_id) > 0 AND fence > 0))
);
CREATE INDEX work_queue_dispatch ON work_queue(tenant_id, priority DESC, created_at, id)
  WHERE status = 'queued';
CREATE INDEX work_queue_expiry ON work_queue(tenant_id, expires_at, id)
  WHERE status = 'leased';
ALTER TABLE work_queue ENABLE ROW LEVEL SECURITY;
ALTER TABLE work_queue FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON work_queue
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
