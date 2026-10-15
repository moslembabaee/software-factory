/** Live PostgreSQL tests use a disposable database, never the application database. */
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { migrateDown, migrateUp, PROJECT_ROOT } from "../migrate.js";
import { verifyMigrationSchema } from "../verify-migrations.js";

const execute = promisify(execFile);
const databaseUrl = process.env["TEST_DATABASE_URL"];
const databaseName = `sf_migrations_${randomBytes(8).toString("hex")}`;
const deliveryDir = "20261015_004_event_delivery";
const queueDir = "20261015_003_work_queue";
const securityDir = "20261015_002_tenant_security";
const initialDir = "20261015_001_initial_schema";
const tenantTables = [
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
].sort();

// CI supplies PostgreSQL 16. A supplied but unreachable URL fails instead of skipping.
describe
  .skipIf(!databaseUrl)
  .sequential("PostgreSQL migration integration", () => {
    let admin: pg.Pool | undefined;
    let pool: pg.Pool;
    let connectionString: string;
    let created = false;
    let closePool: (() => Promise<void>) | undefined;

    beforeAll(async () => {
      if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required");
      admin = new pg.Pool({
        connectionString: databaseUrl,
        connectionTimeoutMillis: 5_000,
      });
      const version = await admin.query<{ server_version_num: string }>(
        "SHOW server_version_num",
      );
      const serverVersion = version.rows[0];
      if (!serverVersion)
        throw new Error("PostgreSQL did not return its version");
      expect(Number(serverVersion.server_version_num)).toBeGreaterThanOrEqual(
        160000,
      );
      await admin.query(`CREATE DATABASE ${databaseName}`);
      created = true;
      const url = new URL(databaseUrl);
      url.pathname = `/${databaseName}`;
      connectionString = url.href;
      pool = new pg.Pool({ connectionString, connectionTimeoutMillis: 5_000 });
      closePool = () => pool.end();
    }, 15_000);

    beforeEach(async () => {
      await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public");
    });

    afterAll(async () => {
      await closePool?.();
      try {
        if (created)
          await admin?.query(`DROP DATABASE ${databaseName} WITH (FORCE)`);
      } finally {
        await admin?.end();
      }
    });

    async function cli(direction: "up" | "down", dry = false): Promise<string> {
      const { stdout } = await execute(
        "npm",
        ["run", `migrate:${direction}`, ...(dry ? ["--", "--dry"] : [])],
        {
          cwd: PROJECT_ROOT,
          env: { ...process.env, DATABASE_URL: connectionString },
          timeout: 20_000,
        },
      );
      return stdout;
    }

    async function tableNames(): Promise<string[]> {
      const result = await pool.query<{ tablename: string }>(
        "SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename",
      );
      return result.rows.map((row) => row.tablename);
    }

    it("runs both npm scripts on a fresh database, preserves every constraint, and reapplies", async () => {
      await expect(verifyMigrationSchema(pool)).rejects.toThrow(
        "missing tables",
      );
      expect(await cli("up", true)).toContain("Would apply");
      expect(await tableNames()).toEqual([]);
      expect(await cli("up")).toContain(`Applied: ${initialDir}`);
      expect(await tableNames()).toEqual(
        ["_migrations", ...tenantTables].sort(),
      );
      await verifyMigrationSchema(pool);
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query('DROP TABLE "relations"');
        await expect(verifyMigrationSchema(client)).rejects.toThrow(
          "missing tables: relations",
        );
      } finally {
        await client.query("ROLLBACK");
        client.release();
      }
      expect(await cli("up")).toContain("No pending migrations");
      const extension = await pool.query(
        "SELECT 1 FROM pg_extension WHERE extname = 'pgcrypto'",
      );
      expect(extension.rowCount).toBe(1);
      const constraints = await pool.query<{
        type: string;
        count: number;
        validated: boolean;
      }>(`
      SELECT contype::text AS type, count(*)::integer AS count, bool_and(convalidated) AS validated
      FROM pg_constraint
      WHERE connamespace = 'public'::regnamespace AND conrelid <> '_migrations'::regclass
      GROUP BY contype ORDER BY contype
    `);
      expect(constraints.rows).toEqual([
        { type: "c", count: 15, validated: true },
        { type: "f", count: 26, validated: true },
        { type: "p", count: 17, validated: true },
        { type: "u", count: 15, validated: true },
      ]);
      const indexes = await pool.query<{
        indexname: string;
        indexdef: string;
      }>(`
      SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'public'
      AND indexname IN ('events_by_execution', 'execution_by_work', 'lease_expiry')
      ORDER BY indexname
    `);
      expect(indexes.rows).toEqual([
        {
          indexname: "events_by_execution",
          indexdef:
            "CREATE INDEX events_by_execution ON public.events USING btree (tenant_id, execution_id, sequence)",
        },
        {
          indexname: "execution_by_work",
          indexdef:
            "CREATE INDEX execution_by_work ON public.executions USING btree (tenant_id, work_id, created_at)",
        },
        {
          indexname: "lease_expiry",
          indexdef:
            "CREATE INDEX lease_expiry ON public.worker_leases USING btree (expires_at)",
        },
      ]);
      expect(await cli("down", true)).toContain("Would roll back");
      expect(await tableNames()).toHaveLength(18);
      expect(await cli("down")).toContain(`Rolled back: ${deliveryDir}`);
      expect(await tableNames()).toHaveLength(18);
      expect(await cli("down")).toContain(`Rolled back: ${queueDir}`);
      expect(await tableNames()).toHaveLength(17);
      expect(await cli("down")).toContain(`Rolled back: ${securityDir}`);
      expect(await tableNames()).toHaveLength(17);
      expect(await cli("down")).toContain(`Rolled back: ${initialDir}`);
      expect(await tableNames()).toEqual(["_migrations"]);
      await expect(verifyMigrationSchema(pool)).rejects.toThrow(
        "missing tables",
      );
      expect((await pool.query("SELECT * FROM _migrations")).rowCount).toBe(0);
      // Preserve the shared extension even when it predates the next up/down cycle.
      expect(
        (
          await pool.query(
            "SELECT 1 FROM pg_extension WHERE extname = 'pgcrypto'",
          )
        ).rowCount,
      ).toBe(1);
      expect(await cli("down")).toContain("Nothing to roll back");
      await cli("up");
      await cli("down");
      await cli("down");
      await cli("down");
      await cli("down");
      expect(await tableNames()).toEqual(["_migrations"]);
    }, 90_000);

    it("enforces tenant constraints and rolls back a populated schema", async () => {
      await migrateUp(pool);
      async function insert(
        sql: string,
        values: unknown[] = [],
      ): Promise<string> {
        const result = await pool.query<{ id: string }>(sql, values);
        const row = result.rows[0];
        if (!row) throw new Error("INSERT did not return an id");
        return row.id;
      }
      const tenant = await insert(
        "INSERT INTO tenants(name) VALUES ('one') RETURNING id",
      );
      const otherTenant = await insert(
        "INSERT INTO tenants(name) VALUES ('two') RETURNING id",
      );
      const actor = await insert(
        "INSERT INTO actors(tenant_id, subject) VALUES ($1, 'owner') RETURNING id",
        [tenant],
      );
      const project = await insert(
        "INSERT INTO projects(tenant_id, name) VALUES ($1, 'project') RETURNING id",
        [tenant],
      );
      const work = await insert(
        "INSERT INTO works(tenant_id, project_id, created_by, objective) VALUES ($1, $2, $3, 'build') RETURNING id",
        [tenant, project, actor],
      );
      const execution = await insert(
        "INSERT INTO executions(tenant_id, work_id, budget_cap_usd) VALUES ($1, $2, 10) RETURNING id",
        [tenant, work],
      );
      await expect(
        pool.query(
          "INSERT INTO actors(tenant_id, subject) VALUES ($1, 'owner')",
          [tenant],
        ),
      ).rejects.toMatchObject({ code: "23505" });
      await expect(
        pool.query(
          "INSERT INTO works(tenant_id, project_id, created_by, objective) VALUES ($1, $2, $3, 'invalid')",
          [otherTenant, project, actor],
        ),
      ).rejects.toMatchObject({ code: "23503" });
      await expect(
        pool.query(
          "INSERT INTO executions(tenant_id, work_id, budget_cap_usd) VALUES ($1, $2, 10)",
          [otherTenant, work],
        ),
      ).rejects.toMatchObject({ code: "23503" });
      for (const update of [
        "state = 'invalid'",
        "budget_cap_usd = -1",
        "reserved_usd = -1",
        "spent_usd = -1",
        "reserved_usd = 6, spent_usd = 5",
      ]) {
        await expect(
          pool.query(`UPDATE executions SET ${update} WHERE id = $1`, [
            execution,
          ]),
        ).rejects.toMatchObject({ code: "23514" });
      }
      await pool.query(
        "INSERT INTO events(tenant_id, execution_id, sequence, type, payload) VALUES ($1, $2, 1, 'created', '{}')",
        [tenant, execution],
      );
      await expect(
        pool.query(
          "INSERT INTO events(tenant_id, execution_id, sequence, type, payload) VALUES ($1, $2, 1, 'duplicate', '{}')",
          [tenant, execution],
        ),
      ).rejects.toMatchObject({ code: "23505" });
      await expect(
        pool.query(
          "INSERT INTO events(tenant_id, execution_id, sequence, type, payload) VALUES ($1, $2, 2, 'invalid', '{}')",
          [otherTenant, execution],
        ),
      ).rejects.toMatchObject({ code: "23503" });
      await expect(
        pool.query(
          "INSERT INTO budget_ledger(tenant_id, execution_id, kind, amount_usd) VALUES ($1, $2, 'invalid', 0)",
          [tenant, execution],
        ),
      ).rejects.toMatchObject({ code: "23514" });
      await expect(
        pool.query(
          "INSERT INTO budget_ledger(tenant_id, execution_id, kind, amount_usd) VALUES ($1, $2, 'settle', -1)",
          [tenant, execution],
        ),
      ).rejects.toMatchObject({ code: "23514" });
      expect(await migrateDown(pool)).toBe(deliveryDir);
      expect(await migrateDown(pool)).toBe(queueDir);
      expect(await migrateDown(pool)).toBe(securityDir);
      expect(await migrateDown(pool)).toBe(initialDir);
      expect(await tableNames()).toEqual(["_migrations"]);
      expect((await pool.query("SELECT * FROM _migrations")).rowCount).toBe(0);
    });

    it("serializes simultaneous up and down calls without applying SQL twice", async () => {
      const results = await Promise.all([migrateUp(pool), migrateUp(pool)]);
      expect(results.flat()).toEqual([
        initialDir,
        securityDir,
        queueDir,
        deliveryDir,
      ]);
      expect((await pool.query("SELECT * FROM _migrations")).rowCount).toBe(4);
      const rolledBack = await Promise.all([
        migrateDown(pool),
        migrateDown(pool),
        migrateDown(pool),
        migrateDown(pool),
      ]);
      expect(rolledBack.filter(Boolean).sort()).toEqual([
        initialDir,
        securityDir,
        queueDir,
        deliveryDir,
      ]);
      expect(await tableNames()).toEqual(["_migrations"]);
    });

    it("rolls back earlier DDL and history when a later migration fails", async () => {
      const directory = mkdtempSync(join(tmpdir(), "sf-migration-failure-"));
      const first = join(directory, "20261015_001_valid");
      const second = join(directory, "20261015_002_invalid");
      mkdirSync(first);
      mkdirSync(second);
      writeFileSync(
        join(first, "up.sql"),
        "CREATE TABLE should_rollback(id integer);",
      );
      writeFileSync(join(first, "down.sql"), "DROP TABLE should_rollback;");
      writeFileSync(
        join(second, "up.sql"),
        "CREATE TABLE also_rollback(id integer); SELECT 1/0;",
      );
      writeFileSync(join(second, "down.sql"), "DROP TABLE also_rollback;");
      try {
        await expect(migrateUp(pool, false, directory)).rejects.toMatchObject({
          code: "22012",
        });
        expect(await tableNames()).toEqual([]);
        // A failed invocation also releases its advisory lock and pooled connection.
        expect(await migrateUp(pool)).toEqual([
          initialDir,
          securityDir,
          queueDir,
          deliveryDir,
        ]);
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    });
  });
