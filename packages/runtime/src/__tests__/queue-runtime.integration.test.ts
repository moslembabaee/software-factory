/** Real outbox/queue transactions and RLS; sandbox adapter is deterministic. */
import { randomBytes, randomUUID } from "node:crypto";
import pg from "pg";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { replayExecution } from "@software-factory/events";
import {
  PostgresDatabase,
  PostgresEventRelay,
} from "@software-factory/storage";
import type { TenantIdentity } from "@software-factory/storage";
import type { Execution, SandboxResult } from "@software-factory/factory-core";
import { migrateDown, migrateUp } from "../../../storage/src/migrate.js";
import { createQueueRuntime } from "../queue-runtime.js";
import type { QueueDispatcherOptions } from "../queue-dispatcher.js";

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Missing test fixture");
  return value;
}

const databaseUrl = process.env["TEST_DATABASE_URL"];
const suffix = randomBytes(8).toString("hex");
const databaseName = `sf_events_${suffix}`;
const roleName = `sf_events_role_${suffix}`;

describe
  .skipIf(!databaseUrl)
  .sequential("queue to sandbox event wiring in PostgreSQL", () => {
    let admin: pg.Pool | undefined;
    let owner: pg.Pool | undefined;
    let pool: pg.Pool | undefined;
    let database: PostgresDatabase;
    let created = false;
    let roleCreated = false;
    let identity: TenantIdentity;
    let executionId: string;

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
      await owner.query(`GRANT USAGE ON SCHEMA public TO ${roleName}`);
      await owner.query(
        `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${roleName}`,
      );
      pool = new pg.Pool({
        connectionString: url.href,
        options: `-c role=${roleName}`,
        connectionTimeoutMillis: 5000,
      });
      database = new PostgresDatabase(pool);
    });

    beforeEach(async () => {
      if (!owner) throw new Error("Database unavailable");
      await owner.query("TRUNCATE tenants CASCADE");
      identity = { tenantId: randomUUID(), actorId: randomUUID() };
      executionId = randomUUID();
      const projectId = randomUUID();
      const workId = randomUUID();
      await owner.query("INSERT INTO tenants(id, name) VALUES ($1, 'events')", [
        identity.tenantId,
      ]);
      await owner.query(
        "INSERT INTO actors(id, tenant_id, subject) VALUES ($1, $2, 'worker')",
        [identity.actorId, identity.tenantId],
      );
      await owner.query(
        "INSERT INTO projects(id, tenant_id, name) VALUES ($1, $2, 'events')",
        [projectId, identity.tenantId],
      );
      await owner.query(
        "INSERT INTO works(id, tenant_id, project_id, created_by, objective) VALUES ($1, $2, $3, $4, 'build')",
        [workId, identity.tenantId, projectId, identity.actorId],
      );
      await database.withTenant(identity, async (client) => {
        await client.query(
          "INSERT INTO executions(id, tenant_id, work_id, budget_cap_usd) VALUES ($1, $2, $3, 10)",
          [executionId, identity.tenantId, workId],
        );
        // Same event+outbox contract as Fastify's execution creation route.
        await client.query(
          `WITH event AS (INSERT INTO events(tenant_id, execution_id, sequence, type, payload)
         VALUES ($1, $2, 0, 'execution.created', '{}') RETURNING id)
         INSERT INTO outbox(event_id) SELECT id FROM event`,
          [identity.tenantId, executionId],
        );
      });
    });

    afterAll(async () => {
      await pool?.end();
      await owner?.end();
      try {
        if (created)
          await admin?.query(`DROP DATABASE ${databaseName} WITH (FORCE)`);
        if (roleCreated) await admin?.query(`DROP ROLE ${roleName}`);
      } finally {
        await admin?.end();
      }
    });

    function runtime(
      status: SandboxResult["status"] = "succeeded",
      resolveProgram: QueueDispatcherOptions["resolveProgram"] = () =>
        Promise.resolve({ code: "console.log('ok')", trust: "trusted" }),
    ) {
      const execute = vi.fn((execution: Execution): Promise<SandboxResult> =>
        Promise.resolve({
          tenantId: execution.tenantId,
          executionId: execution.id,
          sandboxRef: "docker:test",
          status,
          exitCode: status === "succeeded" ? 0 : 1,
          stdout: "",
          stderr: "",
          durationMs: 1,
          cleanupConfirmed: true,
        }),
      );
      return {
        execute,
        ...createQueueRuntime({
          identity,
          database,
          sandbox: { execute },
          workerId: randomUUID(),
          resolveProgram,
        }),
      };
    }

    it("dispatches from persisted creation and completes only after evidenced verification", async () => {
      const worker = runtime();
      expect(await worker.runOnce()).toBe(5);
      expect(worker.execute).toHaveBeenCalledOnce();
      const events = await worker.history.list(identity, executionId);
      expect(events.map((event) => event.type)).toEqual([
        "execution.created",
        "queue.enqueued",
        "execution.dispatched",
        "execution.started",
        "execution.verifying",
      ]);
      expect(replayExecution(events)?.phase).toBe("verifying");
      expect(await worker.history.get(identity, executionId)).toMatchObject({
        state: "verifying",
        version: 2,
      });
      const evidenceId = randomUUID();
      await database.withTenant(identity, async (client) => {
        await client.query(
          "INSERT INTO artifacts(id, tenant_id, execution_id, object_key, sha256, media_type) VALUES ($1, $2, $3, 'verification', $4, 'application/json')",
          [evidenceId, identity.tenantId, executionId, "a".repeat(64)],
        );
      });
      await worker.history.finishVerification(identity, {
        executionId,
        expectedVersion: 2,
        causeEventId: required(events.at(-1)).id,
        evidenceArtifactId: evidenceId,
        outcome: "completed",
      });
      expect(await worker.runOnce()).toBe(1);
      expect(
        replayExecution(await worker.history.list(identity, executionId))
          ?.phase,
      ).toBe("completed");
      expect(await worker.history.get(identity, executionId)).toMatchObject({
        state: "completed",
        version: 3,
      });
      expect(
        (
          await required(owner).query(
            "SELECT * FROM outbox WHERE published_at IS NULL",
          )
        ).rows,
      ).toEqual([]);
    });

    it("records failed sandboxes and does not rerun on redelivery or worker restart", async () => {
      const worker = runtime("failed");
      await worker.runOnce();
      expect(
        replayExecution(await worker.history.list(identity, executionId))
          ?.phase,
      ).toBe("failed");
      await required(owner).query(
        "UPDATE outbox SET published_at = NULL WHERE event_id IN (SELECT id FROM events WHERE type = 'queue.enqueued')",
      );
      const restarted = runtime();
      await restarted.runOnce();
      expect(restarted.execute).not.toHaveBeenCalled();
      expect(worker.execute).toHaveBeenCalledOnce();
    });

    it("fences simultaneous consumers and preserves delivery sequence", async () => {
      const first = runtime();
      const second = runtime();
      const received: number[] = [];
      first.bus.subscribe("*", (event) => {
        received.push(event.sequence);
        return Promise.resolve();
      });
      second.bus.subscribe("*", (event) => {
        received.push(event.sequence);
        return Promise.resolve();
      });
      await Promise.all([first.runOnce(), second.runOnce()]);
      expect(
        first.execute.mock.calls.length + second.execute.mock.calls.length,
      ).toBe(1);
      expect(received).toEqual([0, 1, 2, 3, 4]);
    });

    it("retries a wakeup when an eligible execution is locked by another transaction", async () => {
      const worker = runtime();
      expect(await worker.runOnce(1)).toBe(1); // creation enqueues the dispatch
      const locked = await required(owner).connect();
      try {
        await locked.query("BEGIN");
        await locked.query(
          "SELECT id FROM executions WHERE id = $1 FOR UPDATE",
          [executionId],
        );
        await expect(worker.runOnce()).rejects.toThrow("retry event delivery");
        expect(worker.execute).not.toHaveBeenCalled();
        expect(await worker.queue.get(identity, executionId)).toMatchObject({
          status: "queued",
        });
      } finally {
        await locked.query("ROLLBACK");
        locked.release();
      }
      expect(await worker.runOnce()).toBe(4);
      expect(worker.execute).toHaveBeenCalledOnce();
    });

    it("retries unpublished consumer failures, including after delivery lease expiry", async () => {
      let calls = 0;
      const relay = new PostgresEventRelay(database, {
        publish: () => {
          if (++calls === 1)
            return Promise.reject(new Error("consumer unavailable"));
          return Promise.resolve();
        },
      });
      await expect(relay.flush(identity)).rejects.toThrow(
        "consumer unavailable",
      );
      expect(
        (
          await required(owner).query(
            "SELECT attempts, published_at, delivery_token FROM outbox",
          )
        ).rows,
      ).toEqual([{ attempts: 1, published_at: null, delivery_token: null }]);
      await required(owner).query(
        "UPDATE outbox SET delivery_token = gen_random_uuid(), delivery_expires_at = clock_timestamp() + interval '1 minute'",
      );
      expect(await relay.flush(identity)).toBe(0);
      await required(owner).query(
        "UPDATE outbox SET delivery_expires_at = clock_timestamp() - interval '1 second'",
      );
      expect(await relay.flush(identity)).toBe(1);
      expect(
        (await required(owner).query("SELECT attempts FROM outbox")).rows,
      ).toEqual([{ attempts: 2 }]);
    });

    it("continues other executions while a failed dispatch waits for retry", async () => {
      const otherId = randomUUID();
      await database.withTenant(identity, async (client) => {
        await client.query(
          `INSERT INTO executions(id, tenant_id, work_id, budget_cap_usd)
           SELECT $1, tenant_id, work_id, budget_cap_usd FROM executions
           WHERE tenant_id = $2 AND id = $3`,
          [otherId, identity.tenantId, executionId],
        );
        await client.query(
          `WITH event AS (INSERT INTO events(tenant_id, execution_id, sequence, type, payload)
           VALUES ($1, $2, 0, 'execution.created', '{}') RETURNING id)
           INSERT INTO outbox(event_id) SELECT id FROM event`,
          [identity.tenantId, otherId],
        );
      });
      const resolveProgram = vi.fn<QueueDispatcherOptions["resolveProgram"]>(
        (execution) =>
          execution.id === executionId
            ? Promise.reject(new Error("source unavailable"))
            : Promise.resolve({ code: "console.log('ok')", trust: "trusted" }),
      );
      const worker = runtime("succeeded", resolveProgram);
      await expect(worker.runOnce()).rejects.toThrow("source unavailable");
      expect(worker.execute).toHaveBeenCalledOnce();
      expect(await worker.history.get(identity, executionId)).toMatchObject({
        state: "queued",
      });
      expect(await worker.history.get(identity, otherId)).toMatchObject({
        state: "verifying",
      });
      const pending = await required(owner).query(
        `SELECT e.execution_id, e.type, o.attempts FROM outbox o
         JOIN events e ON e.id = o.event_id WHERE o.published_at IS NULL`,
      );
      expect(pending.rows).toEqual([
        { execution_id: executionId, type: "queue.enqueued", attempts: 1 },
      ]);
      resolveProgram.mockImplementation(() =>
        Promise.resolve({ code: "console.log('ok')", trust: "trusted" }),
      );
      expect(await worker.runOnce()).toBe(4);
      expect(worker.execute).toHaveBeenCalledTimes(2);
      expect(
        replayExecution(await worker.history.list(identity, executionId))
          ?.phase,
      ).toBe("verifying");
    });

    it("denies cross-tenant delivery, reads, completion and direct outbox access", async () => {
      const other = { tenantId: randomUUID(), actorId: randomUUID() };
      const worker = runtime();
      expect(
        await new PostgresEventRelay(database, worker.bus).flush(other),
      ).toBe(0);
      expect(await worker.history.get(other, executionId)).toBeNull();
      expect(await worker.history.list(other, executionId)).toEqual([]);
      expect(await worker.queue.get(other, executionId)).toBeNull();
      await expect(
        worker.history.finishVerification(other, {
          executionId,
          expectedVersion: 2,
          causeEventId: randomUUID(),
          evidenceArtifactId: randomUUID(),
          outcome: "completed",
        }),
      ).rejects.toThrow("expected verification");
      expect((await required(pool).query("SELECT * FROM outbox")).rows).toEqual(
        [],
      );
      await database.withTenant(other, async (client) => {
        expect(
          (
            await client.query(
              "UPDATE outbox SET published_at = clock_timestamp() RETURNING id",
            )
          ).rows,
        ).toEqual([]);
      });
      expect(worker.execute).not.toHaveBeenCalled();
    });

    it("rolls verification back with its event when outbox persistence fails", async () => {
      const worker = runtime();
      await worker.runOnce();
      const events = await worker.history.list(identity, executionId);
      const evidenceId = randomUUID();
      await required(owner).query(
        "INSERT INTO artifacts(id, tenant_id, execution_id, object_key, sha256, media_type) VALUES ($1, $2, $3, 'verification', $4, 'application/json')",
        [evidenceId, identity.tenantId, executionId, "a".repeat(64)],
      );
      await required(owner).query(
        "CREATE FUNCTION fail_event_outbox() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'outbox unavailable'; END $$",
      );
      await required(owner).query(
        "CREATE TRIGGER fail_event_outbox BEFORE INSERT ON outbox FOR EACH ROW EXECUTE FUNCTION fail_event_outbox()",
      );
      try {
        await expect(
          worker.history.finishVerification(identity, {
            executionId,
            expectedVersion: 2,
            causeEventId: required(events.at(-1)).id,
            evidenceArtifactId: evidenceId,
            outcome: "completed",
          }),
        ).rejects.toThrow("outbox unavailable");
        expect(await worker.history.get(identity, executionId)).toMatchObject({
          state: "verifying",
          version: 2,
        });
        expect(await worker.history.list(identity, executionId)).toHaveLength(
          5,
        );
      } finally {
        await required(owner).query(
          "DROP TRIGGER fail_event_outbox ON outbox; DROP FUNCTION fail_event_outbox()",
        );
      }
    });

    it("reverts and reapplies delivery leases without losing pending events", async () => {
      expect(await migrateDown(required(owner))).toBe(
        "20261015_004_event_delivery",
      );
      expect(
        (await required(owner).query("SELECT * FROM outbox")).rows,
      ).toHaveLength(1);
      expect(await migrateUp(required(owner))).toEqual([
        "20261015_004_event_delivery",
      ]);
      expect(await runtime().runOnce()).toBe(5);
    });
  });
