/** HTTP routes against migrated PostgreSQL, using a role that enforces RLS. */
import { randomBytes, randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  PostgresDatabase,
  type TenantIdentity,
} from "@software-factory/storage";
import { migrateUp } from "../../../../packages/storage/src/migrate.js";
import { buildApp } from "../server.js";

const databaseUrl = process.env["TEST_DATABASE_URL"];
const suffix = randomBytes(8).toString("hex");
const databaseName = `sf_api_${suffix}`;
const roleName = `sf_api_role_${suffix}`;

// Match the storage suites: no URL skips; an unreachable supplied URL fails.
describe.skipIf(!databaseUrl).sequential("PostgreSQL resource API", () => {
  let admin: pg.Pool | undefined;
  let owner: pg.Pool | undefined;
  let runtime: pg.Pool | undefined;
  let app: FastifyInstance;
  let closeApp: (() => Promise<void>) | undefined;
  let databaseCreated = false;
  let roleCreated = false;
  const first: TenantIdentity = {
    tenantId: randomUUID(),
    actorId: randomUUID(),
  };
  const second: TenantIdentity = {
    tenantId: randomUUID(),
    actorId: randomUUID(),
  };

  beforeAll(async () => {
    if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required");
    admin = new pg.Pool({
      connectionString: databaseUrl,
      connectionTimeoutMillis: 5000,
    });
    await admin.query(`CREATE DATABASE ${databaseName}`);
    databaseCreated = true;
    await admin.query(
      `CREATE ROLE ${roleName} NOLOGIN NOSUPERUSER NOBYPASSRLS`,
    );
    roleCreated = true;
    const url = new URL(databaseUrl);
    url.pathname = `/${databaseName}`;
    owner = new pg.Pool({
      connectionString: url.href,
      connectionTimeoutMillis: 5000,
    });
    await migrateUp(owner);
    await owner.query(`GRANT USAGE ON SCHEMA public TO ${roleName}`);
    await owner.query(`GRANT SELECT ON actors TO ${roleName}`);
    await owner.query(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON projects, works, "references", relations, idempotency_keys TO ${roleName}`,
    );
    for (const identity of [first, second]) {
      await owner.query(
        "INSERT INTO tenants(id, name) VALUES ($1, 'API test')",
        [identity.tenantId],
      );
      await owner.query(
        "INSERT INTO actors(id, tenant_id, subject) VALUES ($1, $2, 'owner')",
        [identity.actorId, identity.tenantId],
      );
    }
    runtime = new pg.Pool({
      connectionString: url.href,
      options: `-c role=${roleName}`,
      max: 1, // Every request must safely reuse the same connection.
      connectionTimeoutMillis: 5000,
    });
    app = buildApp({
      database: new PostgresDatabase(runtime),
      // Test credentials map to server-owned identities, never tenant headers.
      authenticate: (request) => {
        if (request.headers.authorization === "Bearer first-test-token")
          return first;
        if (request.headers.authorization === "Bearer second-test-token")
          return second;
        return null;
      },
    });
    closeApp = () => app.close();
    await app.ready();
  }, 20000);

  beforeEach(async () => {
    await owner?.query(
      'TRUNCATE projects, "references", idempotency_keys CASCADE',
    );
  });

  afterAll(async () => {
    try {
      await closeApp?.();
    } finally {
      await runtime?.end();
      await owner?.end();
      try {
        if (databaseCreated)
          await admin?.query(`DROP DATABASE ${databaseName} WITH (FORCE)`);
        if (roleCreated) await admin?.query(`DROP ROLE ${roleName}`);
      } finally {
        await admin?.end();
      }
    }
  });

  const headers = { authorization: "Bearer first-test-token" };
  const otherHeaders = { authorization: "Bearer second-test-token" };
  type Row = { id: string; name?: string; version?: number };

  async function create(
    name: string,
    payload: Record<string, unknown>,
  ): Promise<Row> {
    const response = await app.inject({
      method: "POST",
      url: `/api/v1/${name}`,
      payload,
      headers: { ...headers, "idempotency-key": randomUUID() },
    });
    expect(response.statusCode, response.body).toBe(201);
    return response.json<Row>();
  }

  async function resources() {
    const project = await create("projects", { name: "Project" });
    const work = await create("works", {
      project_id: project.id,
      objective: "Build it",
    });
    const reference = await create("references", {
      kind: "work",
      target_id: work.id,
    });
    const relation = await create("relations", {
      from_ref: reference.id,
      to_ref: reference.id,
      kind: "related",
    });
    return [
      { name: "projects", row: project, patch: { name: "Renamed" } },
      { name: "works", row: work, patch: { objective: "Updated", version: 0 } },
      { name: "references", row: reference, patch: { kind: "artifact" } },
      { name: "relations", row: relation, patch: { kind: "depends_on" } },
    ];
  }

  it("persists create, list, get, patch and delete for every CRUD resource", async () => {
    const items = await resources();
    for (const { name, row, patch } of items) {
      const root = `/api/v1/${name}`;
      const listed = await app.inject({
        method: "GET",
        url: `${root}?limit=1&offset=0`,
        headers,
      });
      expect(listed.statusCode).toBe(200);
      expect(listed.json<{ items: Row[] }>().items).toMatchObject([
        { id: row.id },
      ]);
      const updated = await app.inject({
        method: "PATCH",
        url: `${root}/${row.id}`,
        headers,
        payload: patch,
      });
      expect(updated.statusCode, updated.body).toBe(200);
      const expected = name === "works" ? { ...patch, version: 1 } : patch;
      expect(updated.json<unknown>()).toMatchObject(expected);
      const read = await app.inject({
        method: "GET",
        url: `${root}/${row.id}`,
        headers,
      });
      expect(read.statusCode).toBe(200);
      expect(read.json<unknown>()).toMatchObject(expected);
    }
    for (const { name, row } of [...items].reverse()) {
      const url = `/api/v1/${name}/${row.id}`;
      const removed = await app.inject({ method: "DELETE", url, headers });
      expect(removed.statusCode, removed.body).toBe(204);
      expect(removed.body).toBe("");
      expect(
        (await app.inject({ method: "GET", url, headers })).statusCode,
      ).toBe(404);
    }
  });

  it("hides foreign rows and rejects cross-tenant relationships without leaking pooled context", async () => {
    const items = await resources();
    for (const { name, row, patch } of items) {
      const url = `/api/v1/${name}/${row.id}`;
      for (const method of ["GET", "PATCH", "DELETE"] as const) {
        const response = await app.inject({
          method,
          url,
          headers: otherHeaders,
          ...(method === "PATCH" ? { payload: patch } : {}),
        });
        expect(response.statusCode, response.body).toBe(404);
      }
      const listed = await app.inject({
        method: "GET",
        url: `/api/v1/${name}`,
        headers: { ...otherHeaders, "x-tenant-id": first.tenantId },
      });
      expect(listed.statusCode).toBe(200);
      expect(listed.json<{ items: Row[] }>().items).toEqual([]);
      expect(
        (await app.inject({ method: "GET", url, headers })).statusCode,
      ).toBe(200);
    }
    const project = items.find((item) => item.name === "projects");
    const reference = items.find((item) => item.name === "references");
    for (const [name, payload] of [
      ["works", { project_id: project?.row.id, objective: "Forbidden" }],
      [
        "relations",
        {
          from_ref: reference?.row.id,
          to_ref: reference?.row.id,
          kind: "related",
        },
      ],
    ] as const) {
      const response = await app.inject({
        method: "POST",
        url: `/api/v1/${name}`,
        payload,
        headers: { ...otherHeaders, "idempotency-key": randomUUID() },
      });
      expect(response.statusCode, response.body).toBe(409);
      expect(response.json<unknown>()).toMatchObject({ code: "CONFLICT" });
    }
    expect((await runtime?.query("SELECT * FROM projects"))?.rows).toEqual([]);
  });

  it("rolls back a constraint failure and serves subsequent requests on the same connection", async () => {
    const project = await create("projects", { name: "Original" });
    const work = await create("works", {
      project_id: project.id,
      objective: "Build",
    });
    const conflict = await app.inject({
      method: "DELETE",
      url: `/api/v1/projects/${project.id}`,
      headers,
    });
    expect(conflict.statusCode).toBe(409);
    expect(
      (
        await app.inject({
          method: "GET",
          url: `/api/v1/projects/${project.id}`,
          headers,
        })
      ).json<unknown>(),
    ).toMatchObject({ name: "Original" });
    const patch = { objective: "Changed", version: 0 };
    expect(
      (
        await app.inject({
          method: "PATCH",
          url: `/api/v1/works/${work.id}`,
          headers,
          payload: patch,
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await app.inject({
          method: "PATCH",
          url: `/api/v1/works/${work.id}`,
          headers,
          payload: patch,
        })
      ).statusCode,
    ).toBe(409);
    expect((await runtime?.query("SELECT * FROM works"))?.rows).toEqual([]);
  });
});
