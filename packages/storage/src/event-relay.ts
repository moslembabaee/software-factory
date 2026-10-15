import { randomUUID } from "node:crypto";
import { EventSchema } from "@software-factory/factory-core";
import type { EventPublisher } from "@software-factory/events";
import type { TenantDatabase, TenantIdentity } from "./database.js";

interface Delivery {
  outbox_id: string;
  id: string;
  tenant_id: string;
  execution_id: string;
  sequence: string;
  type: string;
  payload: unknown;
  occurred_at: Date;
}

/** A stale delivery may repeat; consumers must deduplicate their durable effects. */
export class PostgresEventRelay {
  constructor(
    private readonly database: TenantDatabase,
    private readonly publisher: EventPublisher,
  ) {}

  async flush(
    identity: TenantIdentity,
    options: { limit?: number; leaseMs?: number } = {},
  ): Promise<number> {
    const limit = options.limit ?? 100;
    const leaseMs = options.leaseMs ?? 60_000;
    if (
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 1000 ||
      !Number.isSafeInteger(leaseMs) ||
      leaseMs < 1 ||
      leaseMs > 86_400_000
    ) {
      throw new TypeError("Invalid event delivery limits");
    }
    let delivered = 0;
    const failedExecutions: string[] = [];
    const errors: unknown[] = [];
    // Bound attempts, including failures, so a batch stays bounded during an outage.
    for (let attempted = 0; attempted < limit; attempted++) {
      const token = randomUUID();
      const row = await this.database.withTenant(identity, async (client) => {
        // Only the earliest unpublished event for a run is eligible. A poison
        // event blocks that run's history rather than silently skipping a fact.
        const selected = await client.query<Delivery>(
          `SELECT o.id AS outbox_id, e.* FROM outbox o JOIN events e ON e.id = o.event_id
           WHERE e.tenant_id = $1 AND o.published_at IS NULL
             AND NOT (e.execution_id = ANY($2::uuid[]))
             AND (o.delivery_expires_at IS NULL OR o.delivery_expires_at <= clock_timestamp())
             AND NOT EXISTS (
               SELECT 1 FROM events earlier JOIN outbox pending ON pending.event_id = earlier.id
               WHERE earlier.tenant_id = e.tenant_id AND earlier.execution_id = e.execution_id
                 AND earlier.sequence < e.sequence AND pending.published_at IS NULL
             )
           ORDER BY e.occurred_at, e.execution_id, e.sequence
           LIMIT 1 FOR UPDATE OF o SKIP LOCKED`,
          [identity.tenantId, [...failedExecutions]],
        );
        const next = selected.rows[0];
        if (!next) return null;
        await client.query(
          `UPDATE outbox SET delivery_token = $2,
             delivery_expires_at = clock_timestamp() + $3 * interval '1 millisecond', attempts = attempts + 1
           WHERE id = $1`,
          [next.outbox_id, token, leaseMs],
        );
        return next;
      });
      if (!row) break;
      try {
        const event = EventSchema.parse({
          id: row.id,
          tenantId: row.tenant_id,
          executionId: row.execution_id,
          sequence: Number(row.sequence),
          type: row.type,
          payload: row.payload,
          occurredAt: row.occurred_at.toISOString(),
        });
        if (event.tenantId !== identity.tenantId)
          throw new Error("Event tenant mismatch");
        await this.publisher.publish(event);
        const acknowledged = await this.database.withTenant(
          identity,
          async (client) =>
            client.query(
              `UPDATE outbox SET published_at = clock_timestamp(), delivery_token = NULL, delivery_expires_at = NULL
           WHERE id = $1 AND delivery_token = $2 AND published_at IS NULL
             AND delivery_expires_at > clock_timestamp() RETURNING id`,
              [row.outbox_id, token],
            ),
        );
        if (!acknowledged.rows.length)
          throw new Error("Event delivery lease expired or changed");
        delivered++;
      } catch (error) {
        await this.database.withTenant(identity, async (client) => {
          await client.query(
            `UPDATE outbox SET delivery_token = NULL, delivery_expires_at = NULL
             WHERE id = $1 AND delivery_token = $2 AND published_at IS NULL`,
            [row.outbox_id, token],
          );
        });
        // Keep this execution pending and ordered, but allow other executions
        // to progress even when the oldest event has a persistent consumer error.
        failedExecutions.push(row.execution_id);
        errors.push(error);
      }
    }
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1)
      throw new AggregateError(errors, "Multiple event deliveries failed");
    return delivered;
  }
}
