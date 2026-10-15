DROP TABLE IF EXISTS work_queue;
ALTER TABLE executions DROP CONSTRAINT executions_tenant_id_id_work_id_key;
