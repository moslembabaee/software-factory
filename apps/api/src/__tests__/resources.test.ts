import type { FastifyInstance } from "fastify";
import type pg from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TenantDatabase } from "@software-factory/storage";
import { buildApp } from "../server.js";

const tenantId = "00000000-0000-4000-8000-000000000001";
const actorId = "00000000-0000-4000-8000-000000000002";
const resourceId = "00000000-0000-4000-8000-000000000003";
const apps: FastifyInstance[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map((app) => app.close())); });

function fixture(authenticated = true) {
  let requestHash: unknown;
  const query = vi.fn<(sql: string, values?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>>()
    .mockImplementation((sql, values) => {
      if (sql.startsWith("INSERT INTO idempotency_keys")) requestHash = values?.[4];
      if (sql.startsWith("SELECT request_hash")) return Promise.resolve({ rows: [{ request_hash: requestHash, response_status: null, response_json: null }] });
      if (sql.startsWith("SELECT * FROM events")) return Promise.resolve({ rows: [] });
      return Promise.resolve({ rows: [{ id: resourceId, tenant_id: tenantId, project_id: resourceId, objective: "Build it", state: "open", version: "0", name: "Project", kind: "work", target_id: resourceId, from_ref: resourceId, to_ref: actorId }] });
    });
  const database: TenantDatabase = {
    withTenant: vi.fn(async (_identity, operation) => operation({ query } as unknown as pg.PoolClient)),
  };
  const app = buildApp({ database, ...(authenticated ? { authenticate: () => ({ tenantId, actorId }) } : {}) });
  apps.push(app);
  return { app, database, query };
}

describe("resource API", () => {
  it("fails closed without trusted authentication despite client identity headers", async () => {
    const { app, database } = fixture(false);
    const response = await app.inject({ method: "GET", url: "/api/v1/projects", headers: { "x-tenant-id": tenantId, "x-actor-id": actorId, authorization: "Bearer unverified" } });
    expect(response.statusCode).toBe(401);
    expect(database.withTenant).not.toHaveBeenCalled();
    expect(response.json()).toMatchObject({ code: "FORBIDDEN", correlation_id: response.headers["x-request-id"] });
  });

  it.each([
    ["projects", { name: "Project" }, { name: "New project" }],
    ["works", { project_id: resourceId, objective: "Build it" }, { objective: "Update it", version: "0" }],
    ["references", { kind: "work", target_id: resourceId }, { kind: "artifact" }],
    ["relations", { kind: "depends_on", from_ref: resourceId, to_ref: actorId }, { kind: "related" }],
  ])("provides create, list, get, patch and delete for %s", async (name, create, update) => {
    const { app, database, query } = fixture();
    const root = `/api/v1/${name}`;
    const created = await app.inject({ method: "POST", url: root, payload: create, headers: { "idempotency-key": "resource-test-key" } });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ id: resourceId });
    expect((await app.inject({ method: "GET", url: `${root}?limit=5&offset=2` })).json()).toMatchObject({ items: [{ id: resourceId }] });
    expect((await app.inject({ method: "GET", url: `${root}/${resourceId}` })).statusCode).toBe(200);
    expect((await app.inject({ method: "PATCH", url: `${root}/${resourceId}`, payload: update })).statusCode).toBe(200);
    const removed = await app.inject({ method: "DELETE", url: `${root}/${resourceId}` });
    expect(removed.statusCode).toBe(204);
    expect(removed.body).toBe("");
    expect(database.withTenant).toHaveBeenCalledWith({ tenantId, actorId }, expect.any(Function));
    expect(query.mock.calls.filter(([sql]) => !sql.startsWith("SELECT id FROM actors")).every(([, values]) => values?.includes(tenantId))).toBe(true);
    if (name === "works") {
      expect(query.mock.calls.find(([sql]) => sql.startsWith('INSERT INTO "works"'))?.[1]).toEqual([tenantId, resourceId, "Build it", actorId]);
      expect(query.mock.calls.find(([sql]) => sql.startsWith('UPDATE "works"'))?.[0]).toContain("version = version + 1");
    }
  });

  it.each([
    ["POST", "/api/v1/works", { project_id: resourceId, objective: "valid", tenant_id: actorId }],
    ["POST", "/api/v1/works", { project_id: resourceId, objective: "valid", created_by: actorId }],
    ["POST", "/api/v1/projects", { name: "  " }],
    ["POST", "/api/v1/works", { objective: "no project" }],
    ["PATCH", `/api/v1/works/${resourceId}`, { objective: "no version" }],
    ["PATCH", `/api/v1/references/${resourceId}`, {}],
    ["PATCH", `/api/v1/works/${resourceId}`, { objective: "bad version", version: "9223372036854775808" }],
    ["GET", "/api/v1/projects/invalid", undefined],
    ["GET", "/api/v1/projects?limit=101", undefined],
  ] as const)("validates %s %s before touching storage", async (method, url, payload) => {
    const { app, database } = fixture();
    const response = await app.inject({ method, url, headers: { "idempotency-key": "resource-test-key" }, ...(payload ? { payload } : {}) });
    expect(response.statusCode).toBe(422);
    expect(database.withTenant).not.toHaveBeenCalled();
  });

  it("parameterizes user text and uses only the resolved identity", async () => {
    const { app, query } = fixture();
    const name = "Robert'); DROP TABLE projects; --";
    const response = await app.inject({ method: "POST", url: "/api/v1/projects", payload: { name }, headers: { "x-tenant-id": resourceId } });
    expect(response.statusCode).toBe(201);
    const insert = query.mock.calls.find(([sql]) => sql.startsWith("INSERT"));
    expect(insert?.[0]).not.toContain(name);
    expect(insert?.[1]).toEqual([tenantId, name]);
  });

  it.each(["GET", "PATCH", "DELETE"] as const)("returns 404 for hidden or missing resources on %s", async (method) => {
    const { app, query } = fixture();
    query.mockImplementation((sql) => Promise.resolve({ rows: sql.startsWith("SELECT id FROM actors") ? [{ id: actorId }] : [] }));
    const response = await app.inject({ method, url: `/api/v1/projects/${resourceId}`, ...(method === "PATCH" ? { payload: { name: "New" } } : {}) });
    expect(response.statusCode).toBe(404);
  });

  it("distinguishes a stale Work version from an inaccessible Work", async () => {
    const { app, query } = fixture();
    query.mockImplementation((sql) => Promise.resolve({ rows: sql.startsWith("UPDATE") ? [] : [{ id: resourceId }] }));
    const response = await app.inject({ method: "PATCH", url: `/api/v1/works/${resourceId}`, payload: { objective: "New", version: 0 } });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ code: "CONFLICT" });
  });

  it("rejects an actor that does not belong to the resolved tenant", async () => {
    const { app, query } = fixture();
    query.mockResolvedValue({ rows: [] });
    expect((await app.inject({ method: "GET", url: "/api/v1/projects" })).statusCode).toBe(401);
    expect(query).toHaveBeenCalledOnce();
  });

  it.each([["23503", 409], ["23505", 409], ["42501", 403], ["23514", 422], ["ECONNREFUSED", 503], ["unexpected", 500]] as const)("maps database error %s without leaking SQL", async (code, status) => {
    const { app, query } = fixture();
    query.mockRejectedValue(Object.assign(new Error("private SQL and credentials"), { code }));
    const response = await app.inject({ method: "GET", url: "/api/v1/projects" });
    expect(response.statusCode).toBe(status);
    expect(response.body).not.toContain("private");
    expect(response.json()).toMatchObject({ correlation_id: response.headers["x-request-id"], retryable: status === 503 });
  });

  it("provides ordered event reads and keeps event history read only", async () => {
    const { app, query } = fixture();
    expect((await app.inject({ method: "GET", url: `/api/v1/executions/${resourceId}/events` })).statusCode).toBe(200);
    expect(query.mock.calls.at(-1)?.[0]).toContain("ORDER BY sequence");
    expect((await app.inject({ method: "DELETE", url: `/api/v1/executions/${resourceId}/events` })).statusCode).toBe(404);
  });
});
