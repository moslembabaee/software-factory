import type pg from "pg";
import type { EventType } from "@software-factory/factory-core";
import type { TenantIdentity } from "./database.js";

/** Caller holds the execution row lock; history and outbox share its transaction. */
export async function appendExecutionEvent(
  client: pg.PoolClient,
  identity: TenantIdentity,
  executionId: string,
  type: EventType,
  payload: Record<string, unknown>,
): Promise<string> {
  const inserted = await client.query<{ id: string }>(
    `INSERT INTO events (tenant_id, execution_id, sequence, type, payload)
     SELECT $1, $2, COALESCE(MAX(sequence), -1) + 1, $3, $4
     FROM events WHERE tenant_id = $1 AND execution_id = $2 RETURNING id`,
    [
      identity.tenantId,
      executionId,
      type,
      JSON.stringify({ ...payload, actor_id: identity.actorId }),
    ],
  );
  const eventId = inserted.rows[0]?.id;
  if (!eventId) throw new Error("Event insert returned no row");
  await client.query("INSERT INTO outbox (event_id) VALUES ($1)", [eventId]);
  return eventId;
}
