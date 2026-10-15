# Software Factory — Autonomous Agent Runtime & Context

**Status:** normative | **Implementation boundary:** `packages/agent-runtime`

## Execution input
```json
{
  "schema_version":"1.0", "execution_id":"uuid", "work_id":"uuid",
  "repo":{"url":"repository-reference","base_sha":"40-hex-sha","branch":"sf/work-id"},
  "task":{"objective":"Fix login redirect","acceptance_criteria":["integration tests pass"]},
  "policy":{"policy_version":"p17","tool_profile":"coding-restricted","approval_mode":"gated"},
  "limits":{"max_steps":80,"max_wall_seconds":3600,"max_cost_usd":15},
  "context_refs":["ref-id"]
}
```

## State machine
`created → initializing → reasoning → tool_pending → tool_running → observing → reasoning ... → verifying → completed`; terminal alternatives: `failed`, `cancelled`, `budget_exhausted`, `approval_denied`, `stalled`. `awaiting_approval` is a suspended state with persisted checkpoint and no worker lease held indefinitely. All transitions emit events and validate allowed prior states.

## Agent loop pseudocode
```python
while step < max_steps and within_time_and_budget():
    context = context_manager.build(task, history, repo_index, budget)
    decision = model.generate(context, tool_schemas)
    if decision.kind == 'finish':
        return verify_and_package(decision)
    if decision.kind != 'tool_call':
        append_observation('invalid_model_output'); continue
    validated = tool_gateway.validate(decision.tool, decision.arguments)
    outcome = tool_gateway.execute_or_suspend(validated, execution_id)
    record_step(decision, outcome)
    if outcome.requires_approval: return checkpoint_and_suspend()
    if stall_detector.repeating_without_progress(): return stop('stalled')
return stop('limit_exceeded')
```

## Context management
System/developer policy (immutable for run) → task/acceptance criteria → repo instructions treated as untrusted task data → retrieved code snippets → compressed history → recent tool results. Track token counts and summarize older observations with provenance links, preserving file paths, error messages, tests and user constraints. Do not summarize away approval decisions or security boundaries. Never inject secret values. Cache summaries by execution and source hash; invalidate on source change.

## Tool catalog (initial)
`repo.search`, `file.read`, `file.patch`, `shell.exec`, `test.run`, `git.diff`, `git.status`, `artifact.publish`; MCP via proxy is opt-in. Use JSON-schema-validated arguments, scoped paths and output truncation with artifact references. Shell defaults to no network, bounded CPU/memory/time and non-root. No direct tool access from model process.

## Model interface
`ModelProvider.generate(messages, tools, limits) -> response` with request ID, usage counters, cancellation and retryable error classification. Providers configurable; no provider-specific semantics in Factory Core. Reasoning traces are not required to be persisted; save concise action summaries and observations for audit.

## Parallelism
Full build: subagents create child Executions linked by Relation, with explicit parent budget partition and no shared writable worktree. Merge through reviewed patches.

## Completion criteria
Agent output is a proposal until tests, diff integrity, policy checks and required human approvals pass. No claim of success based only on model text.

## v6.1 binding clarification
Subagents are required in the full build, not deferred. `completed` in this document is AgentRun proposal completion, not approved Execution delivery. See 38 for child isolation, budget and approval requirements.
