import type {
  AcknowledgeWork,
  DequeueWork,
  EnqueueWork,
  QueueItem,
  QueueStatus,
  WorkQueue,
} from "@software-factory/factory-core";
import type { TenantDatabase, TenantIdentity } from "./database.js";
import { appendExecutionEvent as event } from "./append-event.js";

export class QueueConflictError extends Error {
  override readonly name = "QueueConflictError";
}

interface QueueRow {
  id: string;
  tenant_id: string;
  work_id: string;
  execution_id: string;
  priority: number;
  status: QueueStatus;
  worker_id: string | null;
  fence: string;
  execution_version: string;
  created_at: Date;
  expires_at: Date | null;
}

interface Candidate extends QueueRow {
  execution_state: string;
  current_version: string;
  work_state: string;
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function integer(
  value: number,
  minimum: number,
  maximum = Number.MAX_SAFE_INTEGER,
): void {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new TypeError("Invalid queue integer");
  }
}

function worker(value: string): void {
  if (typeof value !== "string" || !value.trim() || value.length > 200) {
    throw new TypeError("Invalid worker ID");
  }
}

function identifier(value: string): void {
  if (!uuid.test(value)) throw new TypeError("Invalid queue identifier");
}

function safeInteger(value: string): number {
  const result = Number(value);
  integer(result, 0);
  return result;
}

function item(row: QueueRow): QueueItem {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    workId: row.work_id,
    executionId: row.execution_id,
    priority: row.priority,
    status: row.status,
    workerId: row.worker_id,
    fence: safeInteger(row.fence),
    executionVersion: safeInteger(row.execution_version),
    createdAt: row.created_at.toISOString(),
    expiresAt: row.expires_at?.toISOString() ?? null,
  };
}

// Every operation uses the same tenant transaction boundary as the Fastify API.
// The database clock decides expiry, so workers need not synchronize clocks.
export class PostgresWorkQueue implements WorkQueue {
  constructor(private readonly database: TenantDatabase) {}

  async get(
    identity: TenantIdentity,
    executionId: string,
  ): Promise<QueueItem | null> {
    identifier(executionId);
    return this.database.withTenant(identity, async (client) => {
      const result = await client.query<QueueRow>(
        "SELECT * FROM work_queue WHERE tenant_id = $1 AND execution_id = $2",
        [identity.tenantId, executionId],
      );
      return result.rows[0] ? item(result.rows[0]) : null;
    });
  }

  async enqueue(
    identity: TenantIdentity,
    input: EnqueueWork,
  ): Promise<QueueItem> {
    identifier(input.executionId);
    integer(input.expectedVersion, 0);
    const priority = input.priority ?? 0;
    integer(priority, -2147483648, 2147483647);
    return this.database.withTenant(identity, async (client) => {
      const execution = await client.query<{
        work_id: string;
        state: string;
        version: string;
        work_state: string;
      }>(
        `
        SELECT e.work_id, e.state, e.version, w.state AS work_state
        FROM executions e JOIN works w ON w.tenant_id = e.tenant_id AND w.id = e.work_id
        WHERE e.tenant_id = $1 AND e.id = $2 FOR UPDATE OF e, w
      `,
        [identity.tenantId, input.executionId],
      );
      const current = execution.rows[0];
      if (!current) throw new QueueConflictError("Execution is unavailable");
      const existing = await client.query<QueueRow>(
        "SELECT * FROM work_queue WHERE tenant_id = $1 AND execution_id = $2",
        [identity.tenantId, input.executionId],
      );
      // Retries return the original dispatch, including after it has been claimed.
      if (existing.rows[0]) return item(existing.rows[0]);
      if (
        current.state !== "queued" ||
        !["open", "active"].includes(current.work_state) ||
        safeInteger(current.version) !== input.expectedVersion
      ) {
        throw new QueueConflictError(
          "Execution cannot be queued in its current state or version",
        );
      }
      const inserted = await client.query<QueueRow>(
        `
        INSERT INTO work_queue (tenant_id, work_id, execution_id, priority, execution_version)
        VALUES ($1, $2, $3, $4, $5) RETURNING *
      `,
        [
          identity.tenantId,
          current.work_id,
          input.executionId,
          priority,
          current.version,
        ],
      );
      const row = inserted.rows[0];
      if (!row) throw new Error("Queue insert returned no row");
      await event(client, identity, row.execution_id, "queue.enqueued", {
        queue_id: row.id,
        priority,
        expected_version: current.version,
      });
      return item(row);
    });
  }

  async dequeue(
    identity: TenantIdentity,
    input: DequeueWork,
  ): Promise<QueueItem | null> {
    worker(input.workerId);
    if (input.executionId !== undefined) identifier(input.executionId);
    integer(input.leaseMs, 1, 86_400_000);
    return this.database.withTenant(identity, async (client) => {
      // Lock all participating rows, skipping dispatches held by other workers.
      // Ineligible or stale dispatches are drained without handing them to a worker.
      for (;;) {
        const selected = await client.query<Candidate>(
          `
          SELECT q.*, e.state AS execution_state, e.version AS current_version, w.state AS work_state
          FROM work_queue q
          JOIN executions e ON e.tenant_id = q.tenant_id AND e.id = q.execution_id
          JOIN works w ON w.tenant_id = q.tenant_id AND w.id = q.work_id
          WHERE q.tenant_id = $1 AND q.status = 'queued'
            AND ($2::uuid IS NULL OR q.execution_id = $2)
          ORDER BY q.priority DESC, q.created_at, q.id
          LIMIT 1 FOR UPDATE OF q, e, w SKIP LOCKED
        `,
          [identity.tenantId, input.executionId ?? null],
        );
        const row = selected.rows[0];
        if (!row) return null;
        if (
          row.execution_state !== "queued" ||
          row.current_version !== row.execution_version ||
          !["open", "active"].includes(row.work_state)
        ) {
          await client.query(
            "UPDATE work_queue SET status = 'cancelled' WHERE tenant_id = $1 AND id = $2",
            [identity.tenantId, row.id],
          );
          await event(client, identity, row.execution_id, "queue.cancelled", {
            queue_id: row.id,
            expected_version: row.execution_version,
            observed_version: row.current_version,
            execution_state: row.execution_state,
            work_state: row.work_state,
          });
          continue;
        }
        const fence = safeInteger(row.fence) + 1;
        const version = safeInteger(row.current_version) + 1;
        integer(fence, 1);
        integer(version, 1);
        const claimed = await client.query<QueueRow>(
          `
          UPDATE work_queue SET status = 'leased', worker_id = $3, fence = $4,
            execution_version = $5, expires_at = clock_timestamp() + $6 * interval '1 millisecond'
          WHERE tenant_id = $1 AND id = $2 RETURNING *
        `,
          [
            identity.tenantId,
            row.id,
            input.workerId,
            fence,
            version,
            input.leaseMs,
          ],
        );
        const claim = claimed.rows[0];
        if (!claim) throw new Error("Queue claim returned no row");
        await client.query(
          `
          INSERT INTO worker_leases (tenant_id, execution_id, worker_id, fence, expires_at)
          VALUES ($1, $2, $3, $4, $5)
        `,
          [
            identity.tenantId,
            row.execution_id,
            input.workerId,
            fence,
            claim.expires_at,
          ],
        );
        await client.query(
          "UPDATE executions SET state = 'running', version = version + 1 WHERE tenant_id = $1 AND id = $2 AND version = $3",
          [identity.tenantId, row.execution_id, row.current_version],
        );
        await client.query(
          "UPDATE works SET state = 'active', version = version + 1 WHERE tenant_id = $1 AND id = $2 AND state = 'open'",
          [identity.tenantId, row.work_id],
        );
        await event(
          client,
          identity,
          row.execution_id,
          "execution.dispatched",
          {
            queue_id: row.id,
            worker_id: input.workerId,
            fence,
            expected_version: row.current_version,
          },
        );
        await event(client, identity, row.execution_id, "execution.started", {
          queue_id: row.id,
          worker_id: input.workerId,
          fence,
          expected_version: row.current_version,
        });
        return item(claim);
      }
    });
  }

  async ack(
    identity: TenantIdentity,
    input: AcknowledgeWork,
  ): Promise<QueueItem> {
    identifier(input.id);
    worker(input.workerId);
    integer(input.fence, 1);
    integer(input.expectedVersion, 0);
    if (!["verifying", "awaiting_approval", "failed"].includes(input.outcome)) {
      throw new TypeError("Invalid acknowledgement outcome");
    }
    return this.database.withTenant(identity, async (client) => {
      const selected = await client.query<Candidate>(
        `
        SELECT q.*, e.state AS execution_state, e.version AS current_version
        FROM work_queue q JOIN executions e ON e.tenant_id = q.tenant_id AND e.id = q.execution_id
        WHERE q.tenant_id = $1 AND q.id = $2 FOR UPDATE OF q, e
      `,
        [identity.tenantId, input.id],
      );
      const row = selected.rows[0];
      if (
        !row ||
        row.status !== "leased" ||
        row.worker_id !== input.workerId ||
        safeInteger(row.fence) !== input.fence ||
        row.execution_state !== "running" ||
        safeInteger(row.current_version) !== input.expectedVersion ||
        safeInteger(row.execution_version) !== input.expectedVersion
      ) {
        throw new QueueConflictError(
          "Dispatch ownership, state or version has changed",
        );
      }
      // Expiry is checked after row locks are held, including time spent waiting.
      const lease = await client.query(
        `
        DELETE FROM worker_leases WHERE tenant_id = $1 AND execution_id = $2
          AND worker_id = $3 AND fence = $4 AND expires_at > clock_timestamp()
          AND $5::timestamptz > clock_timestamp() RETURNING execution_id
      `,
        [
          identity.tenantId,
          row.execution_id,
          input.workerId,
          input.fence,
          row.expires_at,
        ],
      );
      if (!lease.rows.length)
        throw new QueueConflictError(
          "Dispatch lease has expired or been revoked",
        );
      const updated = await client.query<QueueRow>(
        `
        UPDATE work_queue SET status = 'acknowledged', expires_at = NULL
        WHERE tenant_id = $1 AND id = $2 RETURNING *
      `,
        [identity.tenantId, row.id],
      );
      await client.query(
        "UPDATE executions SET state = $3, version = version + 1 WHERE tenant_id = $1 AND id = $2 AND version = $4",
        [
          identity.tenantId,
          row.execution_id,
          input.outcome,
          input.expectedVersion,
        ],
      );
      await event(
        client,
        identity,
        row.execution_id,
        `execution.${input.outcome}`,
        {
          queue_id: row.id,
          worker_id: input.workerId,
          fence: input.fence,
          expected_version: input.expectedVersion,
        },
      );
      const result = updated.rows[0];
      if (!result) throw new Error("Queue acknowledgement returned no row");
      return item(result);
    });
  }

  async timeout(identity: TenantIdentity, limit = 100): Promise<QueueItem[]> {
    integer(limit, 1, 1000);
    return this.database.withTenant(identity, async (client) => {
      const expired = await client.query<Candidate>(
        `
        SELECT q.*, e.state AS execution_state, e.version AS current_version
        FROM work_queue q JOIN executions e ON e.tenant_id = q.tenant_id AND e.id = q.execution_id
        WHERE q.tenant_id = $1 AND q.status = 'leased' AND q.expires_at <= clock_timestamp()
        ORDER BY q.expires_at, q.id LIMIT $2 FOR UPDATE OF q, e SKIP LOCKED
      `,
        [identity.tenantId, limit],
      );
      const results: QueueItem[] = [];
      for (const row of expired.rows) {
        const status =
          row.execution_state === "running" ? "timed_out" : "cancelled";
        const updated = await client.query<QueueRow>(
          `
          UPDATE work_queue SET status = $3, expires_at = NULL
          WHERE tenant_id = $1 AND id = $2 RETURNING *
        `,
          [identity.tenantId, row.id, status],
        );
        await client.query(
          "DELETE FROM worker_leases WHERE tenant_id = $1 AND execution_id = $2 AND worker_id = $3 AND fence = $4",
          [identity.tenantId, row.execution_id, row.worker_id, row.fence],
        );
        if (status === "timed_out") {
          await client.query(
            "UPDATE executions SET state = 'needs_reconciliation', version = version + 1 WHERE tenant_id = $1 AND id = $2 AND version = $3",
            [identity.tenantId, row.execution_id, row.current_version],
          );
        }
        await event(client, identity, row.execution_id, `queue.${status}`, {
          queue_id: row.id,
          worker_id: row.worker_id,
          fence: row.fence,
          expected_version: row.current_version,
        });
        const result = updated.rows[0];
        if (!result) throw new Error("Queue timeout returned no row");
        results.push(item(result));
      }
      return results;
    });
  }
}
