import type { FastifyInstance, FastifyRequest } from "fastify";
import type pg from "pg";
import { z } from "zod";
import type { TenantDatabase, TenantIdentity } from "@software-factory/storage";
import { ApiError } from "./errors.js";
import { idempotent, registerExecutionRoutes } from "./core.js";
import { createWorkBody, errorResponses, executionSchema, idempotencyHeaders, idParams, responseSchema, uuid, wireResource, workSchema } from "./schemas.js";

const id = z.uuid();
const text = z.string().trim().min(1).max(10_000).regex(/\S/);
const params = z.object({ id });
const pagination = z.strictObject({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
});
const version = z.union([
  z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).transform(String),
  z.string().regex(/^(0|[1-9][0-9]{0,18})$/).refine((v) => BigInt(v) <= 9223372036854775807n),
]);

interface Resource {
  name: string;
  table: string;
  create: z.ZodType<Record<string, unknown>>;
  update: z.ZodType<Record<string, unknown>>;
  creator?: boolean;
  versioned?: boolean;
}

// SQL identifiers are constants here; values always use pg parameters.
const resources: Resource[] = [
  {
    name: "projects", table: '"projects"',
    create: z.strictObject({ name: text }),
    update: z.strictObject({ name: text }),
  },
  {
    name: "works", table: '"works"', creator: true, versioned: true,
    create: z.strictObject({ project_id: id, objective: z.string().min(1).max(20000) }),
    update: z.strictObject({ objective: z.string().min(1).max(20000), version }),
  },
  {
    name: "references", table: '"references"',
    create: z.strictObject({ kind: text, target_id: id }),
    update: z.strictObject({ kind: text.optional(), target_id: id.optional() }).refine((v) => Object.keys(v).length > 0),
  },
  {
    name: "relations", table: '"relations"',
    create: z.strictObject({ from_ref: id, to_ref: id, kind: text }),
    update: z.strictObject({ from_ref: id.optional(), to_ref: id.optional(), kind: text.optional() }).refine((v) => Object.keys(v).length > 0),
  },
];

const resourceSchemas: Record<string, object> = {
  works: workSchema,
  executions: executionSchema,
  projects: { type: "object", additionalProperties: false, required: ["id", "tenant_id", "name", "request_id"], properties: { id: uuid, tenant_id: uuid, name: { type: "string" }, request_id: uuid } },
  actors: { type: "object", additionalProperties: false, required: ["id", "tenant_id", "subject", "request_id"], properties: { id: uuid, tenant_id: uuid, subject: { type: "string" }, request_id: uuid } },
  references: { type: "object", additionalProperties: false, required: ["id", "tenant_id", "kind", "target_id", "request_id"], properties: { id: uuid, tenant_id: uuid, kind: { type: "string" }, target_id: uuid, request_id: uuid } },
  relations: { type: "object", additionalProperties: false, required: ["id", "tenant_id", "kind", "from_ref", "to_ref", "request_id"], properties: { id: uuid, tenant_id: uuid, kind: { type: "string" }, from_ref: uuid, to_ref: uuid, request_id: uuid } },
};
const listQuery = { type: "object", additionalProperties: false, properties: { limit: { type: "integer", minimum: 1, maximum: 100, default: 50 }, offset: { type: "integer", minimum: 0, maximum: 1000000, default: 0 } } };
function inputSchema(schema: z.ZodType): object {
  const { $schema: _dialect, ...json } = z.toJSONSchema(schema, { io: "input" });
  return json;
}

export type Authenticate = (
  request: FastifyRequest,
) => Promise<TenantIdentity | null> | TenantIdentity | null;

declare module "fastify" {
  interface FastifyRequest {
    identity: TenantIdentity | null;
  }
}

export function registerResources(
  app: FastifyInstance,
  database: TenantDatabase,
  authenticate: Authenticate,
): void {
  app.decorateRequest("identity", null);
  app.addHook("onRequest", async (request) => {
    const identity = await authenticate(request);
    if (!identity || !id.safeParse(identity.tenantId).success || !id.safeParse(identity.actorId).success) {
      throw new ApiError(401, "FORBIDDEN", "Authentication required");
    }
    request.identity = identity;
  });

  async function scoped<T>(
    request: FastifyRequest,
    operation: (client: pg.PoolClient, identity: TenantIdentity) => Promise<T>,
  ): Promise<T> {
    const identity = request.identity;
    if (!identity) throw new ApiError(401, "FORBIDDEN", "Authentication required");
    return database.withTenant(identity, async (client) => {
      const actor = await client.query(
        "SELECT id FROM actors WHERE tenant_id = $1 AND id = $2",
        [identity.tenantId, identity.actorId],
      );
      if (!actor.rows.length) throw new ApiError(401, "FORBIDDEN", "Authentication required");
      return operation(client, identity);
    });
  }

  function registerReads(name: string, table: string): void {
    const itemSchema = resourceSchemas[name];
    if (!itemSchema) throw new Error(`Missing schema for ${name}`);
    app.get(`/${name}`, { schema: responseSchema(200, { type: "object", additionalProperties: false, required: ["items", "request_id"], properties: { items: { type: "array", items: itemSchema }, request_id: uuid } }, { querystring: listQuery }) }, async (request) => {
      const { limit, offset } = pagination.parse(request.query);
      const items = await scoped(request, async (client, identity) => {
        const result = await client.query(
          `SELECT * FROM ${table} WHERE tenant_id = $1 ORDER BY id LIMIT $2 OFFSET $3`,
          [identity.tenantId, limit, offset],
        );
        return result.rows.map((row: Record<string, unknown>) => wireResource(name, row, request.id));
      });
      return { items, request_id: request.id };
    });
    app.get(`/${name}/:id`, { schema: responseSchema(200, itemSchema, { params: idParams }) }, async (request) => {
      const { id: resourceId } = params.parse(request.params);
      const item = await scoped(request, async (client, identity) => {
        const result = await client.query(
          `SELECT * FROM ${table} WHERE tenant_id = $1 AND id = $2`,
          [identity.tenantId, resourceId],
        );
        if (!result.rows[0]) throw new ApiError(404, "NOT_FOUND", "Resource not found");
        return result.rows[0];
      });
      return wireResource(name, item, request.id);
    });
  }

  for (const resource of resources) {
    registerReads(resource.name, resource.table);
    const itemSchema = resourceSchemas[resource.name];
    if (!itemSchema) throw new Error(`Missing schema for ${resource.name}`);
    app.post(`/${resource.name}`, { schema: responseSchema(201, itemSchema, { body: resource.name === "works" ? createWorkBody : inputSchema(resource.create), ...(resource.name === "works" ? { headers: idempotencyHeaders } : {}) }) }, async (request, reply) => {
      const body = resource.create.parse(request.body);
      const item = await scoped(request, async (client, identity) => {
        const create = async () => {
        const data = {
          tenant_id: identity.tenantId,
          ...body,
          ...(resource.creator ? { created_by: identity.actorId } : {}),
        };
        const columns = Object.keys(data);
        const result = await client.query(
          `INSERT INTO ${resource.table} (${columns.join(", ")}) VALUES (${columns.map((_, i) => `$${i + 1}`).join(", ")}) RETURNING *`,
          Object.values(data),
        );
        const row: Record<string, unknown> | undefined = result.rows[0];
        if (!row) throw new Error("Resource insert returned no row");
        return { status: 201, body: wireResource(resource.name, row, request.id) };
        };
        return resource.name === "works" ? idempotent(client, identity, request, create) : create();
      });
      return reply.code(item.status).send(item.body);
    });
    app.patch(`/${resource.name}/:id`, { schema: responseSchema(200, itemSchema, { params: idParams, body: { ...inputSchema(resource.update), minProperties: 1 } }) }, async (request) => {
      const { id: resourceId } = params.parse(request.params);
      const body = resource.update.parse(request.body);
      const { version: expectedVersion, ...data } = body;
      const item = await scoped(request, async (client, identity) => {
        const values: unknown[] = Object.values(data);
        const assignments = Object.keys(data).map((column, i) => `${column} = $${i + 1}`);
        if (resource.versioned) assignments.push("version = version + 1");
        values.push(identity.tenantId, resourceId);
        let where = `tenant_id = $${values.length - 1} AND id = $${values.length}`;
        if (resource.versioned) {
          values.push(expectedVersion);
          where += ` AND version = $${values.length}`;
        }
        const result = await client.query(
          `UPDATE ${resource.table} SET ${assignments.join(", ")} WHERE ${where} RETURNING *`, values,
        );
        if (!result.rows[0]) {
          if (resource.versioned) {
            const exists = await client.query(`SELECT id FROM ${resource.table} WHERE tenant_id = $1 AND id = $2`, [identity.tenantId, resourceId]);
            if (exists.rows.length) throw new ApiError(409, "CONFLICT", "Resource version has changed");
          }
          throw new ApiError(404, "NOT_FOUND", "Resource not found");
        }
        return result.rows[0];
      });
      return wireResource(resource.name, item, request.id);
    });
    app.delete(`/${resource.name}/:id`, { schema: { params: idParams, response: { ...errorResponses, 204: { type: "null" } } } }, async (request, reply) => {
      const { id: resourceId } = params.parse(request.params);
      await scoped(request, async (client, identity) => {
        const result = await client.query(
          `DELETE FROM ${resource.table} WHERE tenant_id = $1 AND id = $2 RETURNING id`,
          [identity.tenantId, resourceId],
        );
        if (!result.rows.length) throw new ApiError(404, "NOT_FOUND", "Resource not found");
      });
      return reply.code(204).send();
    });
  }

  // Identity, execution state and append-only history are not generic CRUD data.
  registerReads("actors", '"actors"');
  registerReads("executions", '"executions"');
  registerExecutionRoutes(app, scoped);
}
