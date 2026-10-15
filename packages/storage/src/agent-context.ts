import type { Event } from "@software-factory/factory-core";
import type pg from "pg";
import type { TenantDatabase, TenantIdentity } from "./database.js";
import { appendExecutionEvent } from "./append-event.js";

export interface ContextBinding {
  readonly baseSha: string;
  readonly policyVersion: string;
  readonly modelProfile: string;
}

/** Finalized messages/observations only. Credentials and private reasoning stay out. */
export interface AgentMessage {
  readonly role: "system" | "developer" | "user" | "assistant" | "tool";
  readonly content: string;
  readonly toolCallId?: string;
}

export interface AgentContext extends ContextBinding {
  readonly schemaVersion: 1;
  readonly messages: readonly AgentMessage[];
  readonly summary: string | null;
  readonly metadata: Readonly<Record<string, Event["payload"]>>;
}

export interface AgentCheckpoint {
  readonly id: string;
  readonly tenantId: string;
  readonly workId: string;
  readonly executionId: string;
  readonly sequence: number;
  readonly step: number;
  readonly workerId: string;
  readonly fence: number;
  readonly context: AgentContext;
  readonly createdAt: string;
}

export interface SaveAgentCheckpoint {
  /** Stable across retries of a write with an uncertain response. */
  readonly id: string;
  readonly executionId: string;
  readonly expectedSequence: number;
  readonly expectedVersion: number;
  readonly workerId: string;
  readonly fence: number;
  readonly step: number;
  readonly context: AgentContext;
}

export interface RecoverAgentContext extends ContextBinding {
  readonly executionId: string;
  readonly expectedVersion: number;
}

export class CheckpointConflictError extends Error {
  override readonly name = "CheckpointConflictError";
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function identifier(value: string): void {
  if (!uuid.test(value)) throw new TypeError("Invalid checkpoint identifier");
}
function counter(value: number, minimum = 0): number {
  if (!Number.isSafeInteger(value) || value < minimum)
    throw new TypeError("Invalid checkpoint counter");
  return value;
}
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function binding(value: unknown): asserts value is ContextBinding {
  if (
    !object(value) ||
    typeof value["baseSha"] !== "string" ||
    !/^[0-9a-f]{40}$/i.test(value["baseSha"]) ||
    typeof value["policyVersion"] !== "string" ||
    !value["policyVersion"].trim() ||
    value["policyVersion"].length > 200 ||
    typeof value["modelProfile"] !== "string" ||
    !value["modelProfile"].trim() ||
    value["modelProfile"].length > 200
  )
    throw new TypeError("Invalid checkpoint context binding");
}
function matches(context: ContextBinding, current: ContextBinding): void {
  if (
    context.baseSha !== current.baseSha ||
    context.policyVersion !== current.policyVersion ||
    context.modelProfile !== current.modelProfile
  )
    throw new CheckpointConflictError(
      "Checkpoint base, policy or model has changed",
    );
}
// Reject values JSON.stringify would silently discard or coerce. Sorting also
// gives retry comparison stable semantics when object key order differs.
function canonical(value: unknown, depth = 0): unknown {
  if (depth > 100)
    throw new TypeError("Checkpoint context is cyclic or too deeply nested");
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value))
    return Array.from(value, (entry) => canonical(entry, depth + 1));
  if (
    value &&
    typeof value === "object" &&
    Object.getPrototypeOf(value) === Object.prototype
  )
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, entry]) => [key, canonical(entry, depth + 1)]),
    );
  throw new TypeError("Checkpoint context must contain only JSON values");
}
function validMessage(message: unknown): boolean {
  return (
    object(message) &&
    typeof message["role"] === "string" &&
    ["system", "developer", "user", "assistant", "tool"].includes(
      message["role"],
    ) &&
    typeof message["content"] === "string" &&
    (message["toolCallId"] === undefined ||
      typeof message["toolCallId"] === "string")
  );
}
function serialize(context: unknown): string {
  if (!object(context))
    throw new TypeError("Invalid agent conversation context");
  binding(context);
  if (
    context["schemaVersion"] !== 1 ||
    !Array.isArray(context["messages"]) ||
    !(context["summary"] === null || typeof context["summary"] === "string") ||
    !object(context["metadata"]) ||
    !context["messages"].every(validMessage)
  )
    throw new TypeError("Invalid agent conversation context");
  const json = JSON.stringify(canonical(context));
  if (Buffer.byteLength(json) > 1_048_576)
    throw new TypeError(
      "Checkpoint exceeds 1 MiB; use artifact references for large context",
    );
  return json;
}

interface CheckpointRow {
  id: string;
  tenant_id: string;
  work_id: string;
  execution_id: string;
  sequence: string;
  step: number;
  worker_id: string;
  fence: string;
  context: AgentContext;
  created_at: Date;
}
function checkpoint(row: CheckpointRow): AgentCheckpoint {
  serialize(row.context);
  return {
    id: row.id,
    tenantId: row.tenant_id,
    workId: row.work_id,
    executionId: row.execution_id,
    sequence: counter(Number(row.sequence), 1),
    step: counter(row.step),
    workerId: row.worker_id,
    fence: counter(Number(row.fence), 1),
    context: row.context,
    createdAt: row.created_at.toISOString(),
  };
}
async function latest(
  client: pg.PoolClient,
  tenantId: string,
  executionId: string,
): Promise<AgentCheckpoint | null> {
  const result = await client.query<CheckpointRow>(
    "SELECT * FROM agent_checkpoints WHERE tenant_id = $1 AND execution_id = $2 ORDER BY sequence DESC LIMIT 1",
    [tenantId, executionId],
  );
  return result.rows[0] ? checkpoint(result.rows[0]) : null;
}

/** Durable, append-only context; every write shares the execution's lock and outbox. */
export class PostgresAgentContext {
  constructor(private readonly database: TenantDatabase) {}

  async latest(
    identity: TenantIdentity,
    executionId: string,
  ): Promise<AgentCheckpoint | null> {
    identifier(executionId);
    return this.database.withTenant(identity, (client) =>
      latest(client, identity.tenantId, executionId),
    );
  }

  /** Restore this attempt or its explicitly selected recovery checkpoint. */
  async restore(
    identity: TenantIdentity,
    executionId: string,
    current: ContextBinding,
  ): Promise<AgentCheckpoint | null> {
    identifier(executionId);
    binding(current);
    return this.database.withTenant(identity, async (client) => {
      let saved = await latest(client, identity.tenantId, executionId);
      if (!saved) {
        const result = await client.query<CheckpointRow>(
          `SELECT c.* FROM agent_recoveries r JOIN agent_checkpoints c
           ON c.tenant_id = r.tenant_id AND c.execution_id = r.source_execution_id AND c.id = r.checkpoint_id
           WHERE r.tenant_id = $1 AND r.execution_id = $2`,
          [identity.tenantId, executionId],
        );
        saved = result.rows[0] ? checkpoint(result.rows[0]) : null;
      }
      if (saved) matches(saved.context, current);
      return saved;
    });
  }

  async save(
    identity: TenantIdentity,
    input: SaveAgentCheckpoint,
  ): Promise<AgentCheckpoint> {
    identifier(input.id);
    identifier(input.executionId);
    counter(input.expectedSequence);
    counter(input.expectedVersion);
    counter(input.fence, 1);
    counter(input.step);
    if (input.step > 2_147_483_647)
      throw new TypeError("Checkpoint step exceeds PostgreSQL integer range");
    if (!input.workerId.trim() || input.workerId.length > 200)
      throw new TypeError("Invalid checkpoint worker");
    const json = serialize(input.context); // Freeze caller-owned data before awaiting I/O.
    return this.database.withTenant(identity, async (client) => {
      const locked = await client.query<{
        work_id: string;
        state: string;
        version: string;
      }>(
        "SELECT work_id, state, version FROM executions WHERE tenant_id = $1 AND id = $2 FOR UPDATE",
        [identity.tenantId, input.executionId],
      );
      const execution = locked.rows[0];
      if (
        !execution ||
        execution.state !== "running" ||
        Number(execution.version) !== input.expectedVersion
      )
        throw new CheckpointConflictError(
          "Execution is not at the expected running version",
        );
      const lease = await client.query(
        `SELECT q.id FROM work_queue q JOIN worker_leases l
         ON l.tenant_id = q.tenant_id AND l.execution_id = q.execution_id
         WHERE q.tenant_id = $1 AND q.execution_id = $2 AND q.status = 'leased'
           AND q.worker_id = $3 AND q.fence = $4 AND q.execution_version = $5
           AND l.worker_id = $3 AND l.fence = $4
           AND q.expires_at > clock_timestamp() AND l.expires_at > clock_timestamp()`,
        [
          identity.tenantId,
          input.executionId,
          input.workerId,
          input.fence,
          input.expectedVersion,
        ],
      );
      if (!lease.rows.length)
        throw new CheckpointConflictError(
          "Checkpoint lease expired or was revoked",
        );
      const saved = await latest(client, identity.tenantId, input.executionId);
      if (saved?.id === input.id) {
        if (
          saved.sequence !== input.expectedSequence + 1 ||
          saved.step !== input.step ||
          saved.workerId !== input.workerId ||
          saved.fence !== input.fence ||
          serialize(saved.context) !== json
        )
          throw new CheckpointConflictError(
            "Checkpoint ID was reused with different content",
          );
        return saved;
      }
      if (
        (saved?.sequence ?? 0) !== input.expectedSequence ||
        (saved && input.step <= saved.step)
      )
        throw new CheckpointConflictError(
          "Checkpoint sequence or step has changed",
        );
      let previous = saved;
      if (!previous) {
        const recovered = await client.query<CheckpointRow>(
          `SELECT c.* FROM agent_recoveries r JOIN agent_checkpoints c
           ON c.tenant_id = r.tenant_id AND c.execution_id = r.source_execution_id AND c.id = r.checkpoint_id
           WHERE r.tenant_id = $1 AND r.execution_id = $2`,
          [identity.tenantId, input.executionId],
        );
        previous = recovered.rows[0] ? checkpoint(recovered.rows[0]) : null;
      }
      if (previous) {
        matches(previous.context, JSON.parse(json) as AgentContext);
        if (input.step <= previous.step)
          throw new CheckpointConflictError("Checkpoint step must advance");
      }
      const sequence = counter(input.expectedSequence + 1, 1);
      const result = await client.query<CheckpointRow>(
        `INSERT INTO agent_checkpoints (id, tenant_id, work_id, execution_id, sequence, step, worker_id, fence, context)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
        [
          input.id,
          identity.tenantId,
          execution.work_id,
          input.executionId,
          sequence,
          input.step,
          input.workerId,
          input.fence,
          json,
        ],
      );
      const row = result.rows[0];
      if (!row) throw new Error("Checkpoint insert returned no row");
      await client.query(
        `INSERT INTO agent_runs (tenant_id, execution_id, state, step_count, checkpoint_ref, version)
         VALUES ($1, $2, 'reasoning', $3, $4, 1) ON CONFLICT (tenant_id, execution_id)
         DO UPDATE SET step_count = EXCLUDED.step_count, checkpoint_ref = EXCLUDED.checkpoint_ref, version = agent_runs.version + 1`,
        [identity.tenantId, input.executionId, input.step, input.id],
      );
      await appendExecutionEvent(
        client,
        identity,
        input.executionId,
        "agent.checkpoint.created",
        {
          checkpoint_id: input.id,
          sequence,
          step: input.step,
          worker_id: input.workerId,
          fence: input.fence,
        },
      );
      return checkpoint(row);
    });
  }

  /** Trusted recovery boundary: proposal-only runs with no effects/approvals to replay. */
  async recover(
    identity: TenantIdentity,
    input: RecoverAgentContext,
  ): Promise<string> {
    identifier(input.executionId);
    counter(input.expectedVersion);
    binding(input);
    return this.database.withTenant(identity, async (client) => {
      const selected = await client.query<{
        work_id: string;
        state: string;
        version: string;
        work_state: string;
        budget_ok: boolean;
      }>(
        `SELECT e.work_id, e.state, e.version, w.state AS work_state,
           (e.reserved_usd = 0 AND e.budget_cap_usd > e.spent_usd) AS budget_ok
         FROM executions e JOIN works w ON w.tenant_id = e.tenant_id AND w.id = e.work_id
         WHERE e.tenant_id = $1 AND e.id = $2 FOR UPDATE OF e, w`,
        [identity.tenantId, input.executionId],
      );
      const source = selected.rows[0];
      if (!source)
        throw new CheckpointConflictError("Recovery execution is unavailable");
      const existing = await client.query<{
        execution_id: string;
        context: AgentContext;
      }>(
        `SELECT r.execution_id, c.context FROM agent_recoveries r JOIN agent_checkpoints c
         ON c.tenant_id = r.tenant_id AND c.execution_id = r.source_execution_id AND c.id = r.checkpoint_id
         WHERE r.tenant_id = $1 AND r.source_execution_id = $2`,
        [identity.tenantId, input.executionId],
      );
      if (existing.rows[0]) {
        matches(existing.rows[0].context, input);
        return existing.rows[0].execution_id;
      }
      if (
        source.state !== "needs_reconciliation" ||
        Number(source.version) !== input.expectedVersion ||
        !["open", "active"].includes(source.work_state) ||
        !source.budget_ok
      )
        throw new CheckpointConflictError(
          "Recovery requires a reconciled timeout, runnable Work and available budget",
        );
      const eligible = await client.query(
        `SELECT q.id FROM work_queue q WHERE q.tenant_id = $1 AND q.execution_id = $2 AND q.status = 'timed_out'
         AND NOT EXISTS (SELECT 1 FROM worker_leases WHERE tenant_id = $1 AND execution_id = $2)
         AND NOT EXISTS (SELECT 1 FROM external_effects WHERE tenant_id = $1 AND execution_id = $2 AND status <> 'rejected')
         AND NOT EXISTS (SELECT 1 FROM approvals WHERE tenant_id = $1 AND execution_id = $2)`,
        [identity.tenantId, input.executionId],
      );
      if (!eligible.rows.length)
        throw new CheckpointConflictError(
          "Recovery blocked by effects, approvals or an active dispatch",
        );
      const saved = await latest(client, identity.tenantId, input.executionId);
      if (!saved)
        throw new CheckpointConflictError(
          "No checkpoint available for recovery",
        );
      matches(saved.context, input);
      const created = await client.query<{ id: string }>(
        `INSERT INTO executions (tenant_id, work_id, parent_execution_id, budget_cap_usd)
         SELECT tenant_id, work_id, id, budget_cap_usd - spent_usd FROM executions
         WHERE tenant_id = $1 AND id = $2 RETURNING id`,
        [identity.tenantId, input.executionId],
      );
      const executionId = created.rows[0]?.id;
      if (!executionId) throw new Error("Recovery insert returned no row");
      await client.query(
        "INSERT INTO agent_recoveries (tenant_id, source_execution_id, execution_id, checkpoint_id) VALUES ($1, $2, $3, $4)",
        [identity.tenantId, input.executionId, executionId, saved.id],
      );
      await appendExecutionEvent(
        client,
        identity,
        input.executionId,
        "agent.checkpoint.recovered",
        {
          checkpoint_id: saved.id,
          recovery_execution_id: executionId,
          expected_version: input.expectedVersion,
        },
      );
      await appendExecutionEvent(
        client,
        identity,
        executionId,
        "execution.created",
        {
          parent_execution_id: input.executionId,
          checkpoint_id: saved.id,
          base_sha: input.baseSha,
        },
      );
      return executionId;
    });
  }
}
