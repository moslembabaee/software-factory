UPDATE agent_runs SET checkpoint_ref = NULL, version = version + 1
WHERE EXISTS (SELECT 1 FROM agent_checkpoints c
  WHERE c.tenant_id = agent_runs.tenant_id AND c.execution_id = agent_runs.execution_id
    AND c.id::text = agent_runs.checkpoint_ref);
DROP TABLE agent_recoveries;
DROP TABLE agent_checkpoints;
DROP FUNCTION prevent_agent_context_mutation();
