import { createHash } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type pg from "pg";
import type { TenantIdentity } from "@software-factory/storage";
import { ApiError } from "./errors.js";
import { artifactsSchema, createExecutionBody, errorResponses, eventQuery, eventsSchema, executionSchema, idempotencyHeaders, idParams, responseSchema, wireInteger, wireResource } from "./schemas.js";

export type Scoped = <T>(request: FastifyRequest, operation: (client: pg.PoolClient, identity: TenantIdentity) => Promise<T>) => Promise<T>;
interface Result { status: number; body: Record<string, unknown> | null }

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]));
  return value;
}

/** Runs inside withTenant's transaction; concurrent retries wait on the same key. */
export async function idempotent(
  client: pg.PoolClient, identity: TenantIdentity, request: FastifyRequest,
  operation: () => Promise<Result>,
): Promise<Result> {
  const route = `${request.method} ${request.url.split("?")[0]}`;
  const key = request.headers["idempotency-key"];
  const hash = createHash("sha256").update(JSON.stringify(canonical(request.body ?? null))).digest("hex");
  const values = [identity.tenantId, identity.actorId, route, key];
  await client.query("INSERT INTO idempotency_keys (tenant_id, actor_id, route, key, request_hash) VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING", [...values, hash]);
  const saved = await client.query<{ request_hash: string; response_status: number | null; response_json: Record<string, unknown> | null }>(
    "SELECT request_hash, response_status, response_json FROM idempotency_keys WHERE tenant_id = $1 AND actor_id = $2 AND route = $3 AND key = $4 FOR UPDATE", values,
  );
  const record = saved.rows[0];
  if (!record) throw new Error("Idempotency reservation missing");
  if (record.request_hash !== hash) throw new ApiError(409, "CONFLICT", "Idempotency key was used with a different request");
  if (record.response_status !== null) return { status: record.response_status, body: record.response_json };
  const result = await operation();
  await client.query("UPDATE idempotency_keys SET response_status = $5, response_json = $6 WHERE tenant_id = $1 AND actor_id = $2 AND route = $3 AND key = $4", [...values, result.status, JSON.stringify(result.body)]);
  return result;
}

async function requireExecution(client: pg.PoolClient, tenantId: string, executionId: string): Promise<void> {
  const execution = await client.query("SELECT id FROM executions WHERE tenant_id = $1 AND id = $2", [tenantId, executionId]);
  if (!execution.rows.length) throw new ApiError(404, "NOT_FOUND", "Resource not found");
}

async function appendEvent(client: pg.PoolClient, tenantId: string, executionId: string, type: string, payload: unknown): Promise<void> {
  // Callers hold the execution row lock (or have just created the row).
  await client.query(
    "WITH event AS (INSERT INTO events (tenant_id, execution_id, sequence, type, payload) SELECT $1, $2, COALESCE(MAX(sequence), -1) + 1, $3, $4 FROM events WHERE tenant_id = $1 AND execution_id = $2 RETURNING id) INSERT INTO outbox (event_id) SELECT id FROM event",
    [tenantId, executionId, type, JSON.stringify(payload)],
  );
}

export function registerExecutionRoutes(app: FastifyInstance, scoped: Scoped): void {
  app.post<{ Params: { id: string }; Body: { base_sha: string; budget_cap_usd: number; parent_execution_id?: string } }>("/works/:id/executions", {
    schema: responseSchema(201, executionSchema, { params: idParams, headers: idempotencyHeaders, body: createExecutionBody }),
  }, async (request, reply) => {
    const result = await scoped(request, (client, identity) => idempotent(client, identity, request, async () => {
      const work = await client.query("SELECT id FROM works WHERE tenant_id = $1 AND id = $2", [identity.tenantId, request.params.id]);
      if (!work.rows.length) throw new ApiError(404, "NOT_FOUND", "Resource not found");
      const body = request.body;
      if (body.parent_execution_id) await requireExecution(client, identity.tenantId, body.parent_execution_id);
      const created = await client.query("INSERT INTO executions (tenant_id, work_id, budget_cap_usd, parent_execution_id) VALUES ($1, $2, $3, $4) RETURNING *", [identity.tenantId, request.params.id, body.budget_cap_usd, body.parent_execution_id ?? null]);
      const row: Record<string, unknown> | undefined = created.rows[0];
      if (!row) throw new Error("Execution insert returned no row");
      // The immutable creation event preserves the requested base commit.
      await appendEvent(client, identity.tenantId, String(row["id"]), "execution.created", body);
      return { status: 201, body: wireResource("executions", row, request.id) };
    }));
    return reply.code(result.status).send(result.body);
  });

  app.get<{ Params: { id: string }; Querystring: { cursor?: string; limit: number } }>("/executions/:id/events", {
    schema: responseSchema(200, eventsSchema, { params: idParams, querystring: eventQuery }),
  }, async (request) => {
    const { cursor, limit } = request.query;
    // Opaque to consumers; a decimal sequence is stable across concurrent appends.
    if (cursor !== undefined && (!/^(0|[1-9][0-9]*)$/.test(cursor) || BigInt(cursor) > BigInt(Number.MAX_SAFE_INTEGER))) throw new ApiError(422, "VALIDATION_FAILED", "Invalid event cursor");
    return scoped(request, async (client, identity) => {
      await requireExecution(client, identity.tenantId, request.params.id);
      const result = await client.query("SELECT * FROM events WHERE tenant_id = $1 AND execution_id = $2 AND sequence > $3 ORDER BY sequence LIMIT $4", [identity.tenantId, request.params.id, cursor ?? "-1", limit + 1]);
      const rows: Record<string, unknown>[] = result.rows;
      const items = rows.slice(0, limit).map((row) => ({ event_id: row["id"], execution_id: row["execution_id"], sequence: wireInteger(row["sequence"]), type: row["type"], occurred_at: row["occurred_at"] instanceof Date ? row["occurred_at"].toISOString() : row["occurred_at"], payload: row["payload"] }));
      return { items, next_cursor: rows.length > limit ? String(items.at(-1)?.sequence) : null };
    });
  });

  app.get<{ Params: { id: string } }>("/executions/:id/artifacts", {
    schema: responseSchema(200, artifactsSchema, { params: idParams }),
  }, async (request) => scoped(request, async (client, identity) => {
    await requireExecution(client, identity.tenantId, request.params.id);
    const result = await client.query("SELECT id, sha256, media_type FROM artifacts WHERE tenant_id = $1 AND execution_id = $2 ORDER BY id", [identity.tenantId, request.params.id]);
    return { items: result.rows };
  }));

  app.post<{ Params: { id: string } }>("/executions/:id/cancel", {
    schema: { params: idParams, headers: idempotencyHeaders, response: { ...errorResponses, 202: { type: "null" } } },
  }, async (request, reply) => {
    const result = await scoped(request, (client, identity) => idempotent(client, identity, request, async () => {
      const current = await client.query<{ state: string; version: string }>("SELECT state, version FROM executions WHERE tenant_id = $1 AND id = $2 FOR UPDATE", [identity.tenantId, request.params.id]);
      const row = current.rows[0];
      if (!row) throw new ApiError(404, "NOT_FOUND", "Resource not found");
      if (!["queued", "running", "awaiting_approval", "cancelling"].includes(row.state)) throw new ApiError(409, "CONFLICT", "Execution cannot be cancelled in its current state");
      if (row.state !== "cancelling") {
        await client.query("UPDATE executions SET state = 'cancelling', version = version + 1 WHERE tenant_id = $1 AND id = $2 AND version = $3", [identity.tenantId, request.params.id, row.version]);
        await client.query("DELETE FROM worker_leases WHERE tenant_id = $1 AND execution_id = $2", [identity.tenantId, request.params.id]);
        await appendEvent(client, identity.tenantId, request.params.id, "execution.cancellation_requested", { actor_id: identity.actorId, expected_version: row.version });
      }
      return { status: 202, body: null };
    }));
    return reply.code(result.status).send();
  });
}
