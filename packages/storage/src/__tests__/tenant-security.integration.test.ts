/** Exercise policies with a real PostgreSQL role, including unfiltered SQL. */
import { randomBytes, randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresDatabase, type TenantIdentity } from "../database.js";
import { migrateUp } from "../migrate.js";
import { verifyMigrationSchema } from "../verify-migrations.js";

const databaseUrl = process.env["TEST_DATABASE_URL"];
const suffix = randomBytes(8).toString("hex");
const databaseName = `sf_security_${suffix}`;
const roleName = `sf_security_role_${suffix}`;
const tables = [
  "tenants",
  "actors",
  "projects",
  "works",
  "executions",
  "events",
  "outbox",
  "idempotency_keys",
  "agent_runs",
  "worker_leases",
  "approvals",
  "external_effects",
  "budget_ledger",
  "artifacts",
  "references",
  "relations",
  "work_queue",
];

// A supplied but unreachable URL fails. Each suite owns its database and role.
describe.skipIf(!databaseUrl).sequential("PostgreSQL tenant security", () => {
  let admin: pg.Pool | undefined;
  let owner: pg.Pool | undefined;
  let runtime: pg.Pool | undefined;
  let database: PostgresDatabase;
  let created = false;
  let roleCreated = false;
  let first: TenantIdentity;
  let second: TenantIdentity;
  const firstRows = new Map<string, Record<string, unknown>>();
  const secondRows = new Map<string, Record<string, unknown>>();

  async function seed(pool: pg.Pool, identity: TenantIdentity) {
    const project = randomUUID();
    const work = randomUUID();
    const execution = randomUUID();
    const event = randomUUID();
    const reference = randomUUID();
    await pool.query("INSERT INTO tenants(id, name) VALUES ($1, 'test')", [
      identity.tenantId,
    ]);
    await pool.query(
      "INSERT INTO actors(id, tenant_id, subject) VALUES ($1, $2, 'owner')",
      [identity.actorId, identity.tenantId],
    );
    await pool.query(
      "INSERT INTO projects(id, tenant_id, name) VALUES ($1, $2, 'project')",
      [project, identity.tenantId],
    );
    await pool.query(
      "INSERT INTO works(id, tenant_id, project_id, created_by, objective) VALUES ($1, $2, $3, $4, 'build')",
      [work, identity.tenantId, project, identity.actorId],
    );
    await pool.query(
      "INSERT INTO executions(id, tenant_id, work_id, budget_cap_usd) VALUES ($1, $2, $3, 10)",
      [execution, identity.tenantId, work],
    );
    await pool.query(
      "INSERT INTO events(id, tenant_id, execution_id, sequence, type, payload) VALUES ($1, $2, $3, 0, 'created', '{}')",
      [event, identity.tenantId, execution],
    );
    await pool.query("INSERT INTO outbox(event_id) VALUES ($1)", [event]);
    await pool.query(
      "INSERT INTO idempotency_keys(tenant_id, actor_id, route, key, request_hash) VALUES ($1, $2, '/test', 'key', 'hash')",
      [identity.tenantId, identity.actorId],
    );
    await pool.query(
      "INSERT INTO agent_runs(tenant_id, execution_id, state) VALUES ($1, $2, 'running')",
      [identity.tenantId, execution],
    );
    await pool.query(
      "INSERT INTO worker_leases(tenant_id, execution_id, worker_id, fence, expires_at) VALUES ($1, $2, 'worker', 1, now() + interval '1 hour')",
      [identity.tenantId, execution],
    );
    await pool.query(
      "INSERT INTO approvals(tenant_id, execution_id, reviewer_id, action_digest, policy_version, base_sha, patch_sha, evidence_digest, expires_at) VALUES ($1, $2, $3, $4, 'v1', $5, $4, $4, now() + interval '1 hour')",
      [
        identity.tenantId,
        execution,
        identity.actorId,
        "a".repeat(64),
        "b".repeat(40),
      ],
    );
    await pool.query(
      "INSERT INTO external_effects(tenant_id, execution_id, provider, action_digest, status, fence) VALUES ($1, $2, 'test', $3, 'prepared', 1)",
      [identity.tenantId, execution, "a".repeat(64)],
    );
    await pool.query(
      "INSERT INTO budget_ledger(tenant_id, execution_id, kind, amount_usd) VALUES ($1, $2, 'settle', 0)",
      [identity.tenantId, execution],
    );
    await pool.query(
      "INSERT INTO artifacts(tenant_id, execution_id, object_key, sha256, media_type) VALUES ($1, $2, 'object', $3, 'text/plain')",
      [identity.tenantId, execution, "a".repeat(64)],
    );
    await pool.query(
      "INSERT INTO \"references\"(id, tenant_id, kind, target_id) VALUES ($1, $2, 'work', $3)",
      [reference, identity.tenantId, work],
    );
    await pool.query(
      "INSERT INTO relations(tenant_id, from_ref, to_ref, kind) VALUES ($1, $2, $2, 'related')",
      [identity.tenantId, reference],
    );
    await pool.query(
      "INSERT INTO work_queue(tenant_id, work_id, execution_id, execution_version) VALUES ($1, $2, $3, 0)",
      [identity.tenantId, work, execution],
    );
  }

  beforeAll(async () => {
    if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required");
    admin = new pg.Pool({
      connectionString: databaseUrl,
      connectionTimeoutMillis: 5000,
    });
    await admin.query(`CREATE DATABASE ${databaseName}`);
    created = true;
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
    first = { tenantId: randomUUID(), actorId: randomUUID() };
    second = { tenantId: randomUUID(), actorId: randomUUID() };
    await seed(owner, first);
    await seed(owner, second);
    await verifyMigrationSchema(owner);
    await owner.query(`GRANT USAGE, CREATE ON SCHEMA public TO ${roleName}`);
    for (const table of tables) {
      const result = await owner.query<Record<string, unknown>>(
        `SELECT * FROM "${table}"`,
      );
      const tenantColumn = table === "tenants" ? "id" : "tenant_id";
      if (table === "outbox") {
        const events = await owner.query<{ id: string; tenant_id: string }>(
          "SELECT id, tenant_id FROM events",
        );
        for (const row of result.rows) {
          const tenant = events.rows.find(
            (item) => item.id === row["event_id"],
          )?.tenant_id;
          (tenant === first.tenantId ? firstRows : secondRows).set(table, row);
        }
      } else {
        for (const row of result.rows) {
          (row[tenantColumn] === first.tenantId ? firstRows : secondRows).set(
            table,
            row,
          );
        }
      }
      // FORCE must protect even a table owner, not just ordinary grantees.
      await owner.query(`ALTER TABLE "${table}" OWNER TO ${roleName}`);
    }
    runtime = new pg.Pool({
      connectionString: url.href,
      options: `-c role=${roleName}`,
      max: 1,
      connectionTimeoutMillis: 5000,
    });
    database = new PostgresDatabase(runtime);
  }, 20000);

  afterAll(async () => {
    await runtime?.end();
    await owner?.end();
    try {
      if (created)
        await admin?.query(`DROP DATABASE ${databaseName} WITH (FORCE)`);
      if (roleCreated) await admin?.query(`DROP ROLE ${roleName}`);
    } finally {
      await admin?.end();
    }
  });

  it("fails closed on a fresh connection without tenant context", async () => {
    expect((await runtime?.query("SELECT * FROM projects"))?.rows).toEqual([]);
  });

  it.each([
    "ALTER TABLE projects DISABLE ROW LEVEL SECURITY",
    "ALTER TABLE projects NO FORCE ROW LEVEL SECURITY",
    "DROP POLICY tenant_isolation ON projects",
  ])("detects deployed security regressions: %s", async (sql) => {
    if (!owner) throw new Error("Database fixture not initialized");
    const client = await owner.connect();
    try {
      await client.query("BEGIN");
      await client.query(sql);
      await expect(verifyMigrationSchema(client)).rejects.toThrow(
        "tenant RLS missing or incomplete: projects",
      );
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });

  it.each(tables)(
    "isolates unfiltered reads and denies foreign writes on %s",
    async (table) => {
      const own = firstRows.get(table);
      const foreign = secondRows.get(table);
      expect(own).toBeDefined();
      expect(foreign).toBeDefined();
      await database.withTenant(first, async (client) => {
        expect((await client.query(`SELECT * FROM "${table}"`)).rows).toEqual([
          own,
        ]);
      });
      await database.withTenant(second, async (client) => {
        expect((await client.query(`SELECT * FROM "${table}"`)).rows).toEqual([
          foreign,
        ]);
      });
      // json_populate_record supplies every column, including composite keys.
      await expect(
        database.withTenant(first, async (client) => {
          await client.query(
            `INSERT INTO "${table}" SELECT * FROM json_populate_record(NULL::"${table}", $1::json)`,
            [JSON.stringify(foreign)],
          );
        }),
      ).rejects.toMatchObject({ code: "42501" });
      await database.withTenant(first, async (client) => {
        for (const mutation of ["UPDATE", "DELETE"]) {
          const column =
            table === "idempotency_keys" || table === "worker_leases"
              ? "tenant_id"
              : "id";
          const result = await client.query(
            mutation === "UPDATE"
              ? `UPDATE "${table}" SET ${column} = ${column} WHERE ${column} = $1`
              : `DELETE FROM "${table}" WHERE ${column} = $1`,
            [foreign?.[column]],
          );
          expect(result.rowCount).toBe(0);
        }
      });
      // Transaction-local identity must disappear on this reused connection.
      expect((await runtime?.query(`SELECT * FROM "${table}"`))?.rows).toEqual(
        [],
      );
      await expect(
        runtime?.query(
          `INSERT INTO "${table}" SELECT * FROM json_populate_record(NULL::"${table}", $1::json)`,
          [JSON.stringify(own)],
        ),
      ).rejects.toMatchObject({ code: "42501" });
    },
  );

  it("rolls back failures and removes their tenant identity before reuse", async () => {
    await expect(
      database.withTenant(first, async (client) => {
        await client.query("UPDATE projects SET name = 'must roll back'");
        throw new Error("rollback");
      }),
    ).rejects.toThrow("rollback");
    expect((await runtime?.query("SELECT * FROM projects"))?.rows).toEqual([]);
    await database.withTenant(first, async (client) => {
      expect((await client.query("SELECT name FROM projects")).rows).toEqual([
        { name: "project" },
      ]);
    });
  });

  it.each(["events", "budget_ledger"])(
    "keeps own immutable history in %s",
    async (table) => {
      for (const sql of [
        `UPDATE "${table}" SET id = id`,
        `DELETE FROM "${table}"`,
      ]) {
        await expect(
          database.withTenant(first, async (client) => {
            await client.query(sql);
          }),
        ).rejects.toMatchObject({ code: "42501" });
      }
    },
  );

  it("rejects same-tenant rows referencing actors or projects in another tenant", async () => {
    for (const [project, actor] of [
      [secondRows.get("projects")?.["id"], first.actorId],
      [firstRows.get("projects")?.["id"], second.actorId],
    ]) {
      await expect(
        database.withTenant(first, async (client) => {
          await client.query(
            "INSERT INTO works(tenant_id, project_id, created_by, objective) VALUES ($1, $2, $3, 'invalid')",
            [first.tenantId, project, actor],
          );
        }),
      ).rejects.toMatchObject({ code: "23503" });
    }
  });
});
