/** Uses a disposable database and a role that cannot bypass RLS. */
import { randomBytes, randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  PostgresDatabase,
  type TenantDatabase,
  type TenantIdentity,
} from "../database.js";
import { migrateDown, migrateUp } from "../migrate.js";
import { PostgresWorkQueue, QueueConflictError } from "../work-queue.js";

const databaseUrl = process.env["TEST_DATABASE_URL"];
const suffix = randomBytes(8).toString("hex");
const databaseName = `sf_queue_${suffix}`;
const roleName = `sf_queue_role_${suffix}`;

describe.skipIf(!databaseUrl).sequential("PostgreSQL work queue", () => {
  const pools: Partial<Record<"admin" | "owner" | "runtime", pg.Pool>> = {};
  let admin: pg.Pool;
  let owner: pg.Pool;
  let runtime: pg.Pool;
  let database: PostgresDatabase;
  let queue: PostgresWorkQueue;
  let created = false;
  let roleCreated = false;
  let identity: TenantIdentity;
  let projectId: string;

  beforeAll(async () => {
    if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required");
    admin = pools.admin = new pg.Pool({
      connectionString: databaseUrl,
      connectionTimeoutMillis: 5000,
    });
    admin.on("error", () => {});
    await admin.query(`CREATE DATABASE ${databaseName}`);
    created = true;
    await admin.query(
      `CREATE ROLE ${roleName} NOLOGIN NOSUPERUSER NOBYPASSRLS`,
    );
    roleCreated = true;
    const url = new URL(databaseUrl);
    url.pathname = `/${databaseName}`;
    owner = pools.owner = new pg.Pool({
      connectionString: url.href,
      connectionTimeoutMillis: 5000,
    });
    owner.on("error", () => {});
    await migrateUp(owner);
    await owner.query(`GRANT USAGE ON SCHEMA public TO ${roleName}`);
    await owner.query(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${roleName}`,
    );
    runtime = pools.runtime = new pg.Pool({
      connectionString: url.href,
      options: `-c role=${roleName}`,
      max: 12,
      connectionTimeoutMillis: 5000,
    });
    runtime.on("error", () => {});
    database = new PostgresDatabase(runtime);
    queue = new PostgresWorkQueue(database);
  }, 20000);

  beforeEach(async () => {
    await owner.query("TRUNCATE tenants CASCADE");
    identity = { tenantId: randomUUID(), actorId: randomUUID() };
    projectId = randomUUID();
    await owner.query(
      "INSERT INTO tenants (id, name) VALUES ($1, 'queue test')",
      [identity.tenantId],
    );
    await owner.query(
      "INSERT INTO actors (id, tenant_id, subject) VALUES ($1, $2, 'owner')",
      [identity.actorId, identity.tenantId],
    );
    await owner.query(
      "INSERT INTO projects (id, tenant_id, name) VALUES ($1, $2, 'test')",
      [projectId, identity.tenantId],
    );
  });

  afterAll(async () => {
    await pools.runtime?.end();
    await pools.owner?.end();
    try {
      if (created)
        await admin.query(`DROP DATABASE ${databaseName} WITH (FORCE)`);
      if (roleCreated) await admin.query(`DROP ROLE ${roleName}`);
    } finally {
      await pools.admin?.end();
    }
  });

  async function execution(workId: string = randomUUID()): Promise<string> {
    await owner.query(
      "INSERT INTO works (id, tenant_id, project_id, created_by, objective) VALUES ($1, $2, $3, $4, 'build') ON CONFLICT DO NOTHING",
      [workId, identity.tenantId, projectId, identity.actorId],
    );
    const id = randomUUID();
    await owner.query(
      "INSERT INTO executions (id, tenant_id, work_id, budget_cap_usd) VALUES ($1, $2, $3, 10)",
      [id, identity.tenantId, workId],
    );
    return id;
  }

  async function enqueue(priority = 0, workId?: string) {
    const executionId = await execution(workId);
    return queue.enqueue(identity, {
      executionId,
      expectedVersion: 0,
      priority,
    });
  }

  const claim = { workerId: "worker-1", leaseMs: 60000 };

  async function expire(id: string): Promise<void> {
    await owner.query(
      "UPDATE work_queue SET expires_at = clock_timestamp() - interval '1 second' WHERE id = $1",
      [id],
    );
    await owner.query(
      "UPDATE worker_leases SET expires_at = clock_timestamp() - interval '1 second' WHERE execution_id = (SELECT execution_id FROM work_queue WHERE id = $1)",
      [id],
    );
  }

  it("persists across queue instances and atomically activates Work and Execution", async () => {
    const queued = await enqueue();
    expect(queued).toMatchObject({
      status: "queued",
      priority: 0,
      workerId: null,
      fence: 0,
    });
    const recovered = new PostgresWorkQueue(new PostgresDatabase(runtime));
    const leased = await recovered.dequeue(identity, claim);
    expect(leased).toMatchObject({
      id: queued.id,
      status: "leased",
      workerId: claim.workerId,
      fence: 1,
      executionVersion: 1,
    });
    expect(leased?.expiresAt).toBeTruthy();
    expect(
      (
        await owner.query(
          "SELECT state, version FROM executions WHERE id = $1",
          [queued.executionId],
        )
      ).rows,
    ).toEqual([{ state: "running", version: "1" }]);
    expect(
      (
        await owner.query("SELECT state, version FROM works WHERE id = $1", [
          queued.workId,
        ])
      ).rows,
    ).toEqual([{ state: "active", version: "1" }]);
    expect(
      (await owner.query("SELECT fence, worker_id FROM worker_leases")).rows,
    ).toEqual([{ fence: "1", worker_id: claim.workerId }]);
    expect(await recovered.dequeue(identity, claim)).toBeNull();
  });

  it("dequeues highest priority first and FIFO within a priority", async () => {
    const low = await enqueue(-1);
    const first = await enqueue(5);
    const second = await enqueue(5);
    for (const expected of [first, second, low]) {
      expect((await queue.dequeue(identity, claim))?.id).toBe(expected.id);
    }
  });

  it("deduplicates simultaneous enqueue calls and retries after a claim", async () => {
    const executionId = await execution();
    const input = { executionId, expectedVersion: 0, priority: 3 };
    const results = await Promise.all(
      Array.from({ length: 8 }, () => queue.enqueue(identity, input)),
    );
    expect(new Set(results.map((result) => result.id)).size).toBe(1);
    const leased = await queue.dequeue(identity, claim);
    expect(await queue.enqueue(identity, input)).toEqual(leased);
    expect((await owner.query("SELECT * FROM work_queue")).rowCount).toBe(1);
    expect(
      (await owner.query("SELECT * FROM events WHERE type = 'queue.enqueued'"))
        .rowCount,
    ).toBe(1);
  });

  it("holds the Work eligibility lock until enqueue commits", async () => {
    const executionId = await execution();
    const editor = await owner.connect();
    try {
      await editor.query("BEGIN");
      await editor.query("SET LOCAL lock_timeout = '100ms'");
      const holdingDatabase: TenantDatabase = {
        withTenant: (tenant, operation) =>
          database.withTenant(tenant, async (client) => {
            const result = await operation(client);
            // This update must wait until the queue's transaction commits. Foreign
            // key KEY SHARE locks alone do not protect the Work's mutable state.
            await expect(
              editor.query(
                "UPDATE works SET state = 'paused' WHERE tenant_id = $1",
                [identity.tenantId],
              ),
            ).rejects.toMatchObject({ code: "55P03" });
            return result;
          }),
      };
      const guardedQueue = new PostgresWorkQueue(holdingDatabase);
      expect(
        await guardedQueue.enqueue(identity, {
          executionId,
          expectedVersion: 0,
        }),
      ).toMatchObject({ status: "queued" });
    } finally {
      await editor.query("ROLLBACK");
      editor.release();
    }
    expect((await queue.dequeue(identity, claim))?.executionId).toBe(
      executionId,
    );
  });

  it("never delivers one dispatch to two concurrent consumers", async () => {
    const queued = await Promise.all(
      Array.from({ length: 8 }, () => enqueue()),
    );
    const leased = await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        queue.dequeue(identity, { ...claim, workerId: `worker-${String(i)}` }),
      ),
    );
    const ids = leased.flatMap((result) => (result ? [result.id] : []));
    expect(ids.sort()).toEqual(queued.map((result) => result.id).sort());
    expect(new Set(ids).size).toBe(8);
  });

  it("skips a locked execution without waiting for another consumer", async () => {
    const locked = await enqueue(10);
    const available = await enqueue(0);
    const client = await owner.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT id FROM executions WHERE id = $1 FOR UPDATE", [
        locked.executionId,
      ]);
      expect((await queue.dequeue(identity, claim))?.id).toBe(available.id);
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
    expect((await queue.dequeue(identity, claim))?.id).toBe(locked.id);
  });

  it("skips locked dispatches and Works as well as locked executions", async () => {
    for (const table of ["work_queue", "works"]) {
      const locked = await enqueue(10);
      const available = await enqueue(0);
      const client = await owner.connect();
      try {
        await client.query("BEGIN");
        await client.query(`SELECT id FROM ${table} WHERE id = $1 FOR UPDATE`, [
          table === "works" ? locked.workId : locked.id,
        ]);
        expect((await queue.dequeue(identity, claim))?.id).toBe(available.id);
      } finally {
        await client.query("ROLLBACK");
        client.release();
      }
      expect((await queue.dequeue(identity, claim))?.id).toBe(locked.id);
    }
  });

  it("drains stale dispatch versions and continues to the next eligible item", async () => {
    const stale = await enqueue(10);
    const available = await enqueue();
    await owner.query(
      "UPDATE executions SET version = version + 1 WHERE id = $1",
      [stale.executionId],
    );
    expect((await queue.dequeue(identity, claim))?.id).toBe(available.id);
    expect(
      (
        await owner.query("SELECT status FROM work_queue WHERE id = $1", [
          stale.id,
        ])
      ).rows,
    ).toEqual([{ status: "cancelled" }]);
    expect(
      (
        await owner.query(
          "SELECT state, version FROM executions WHERE id = $1",
          [stale.executionId],
        )
      ).rows,
    ).toEqual([{ state: "queued", version: "1" }]);
    expect(
      (
        await owner.query(
          "SELECT * FROM worker_leases WHERE execution_id = $1",
          [stale.executionId],
        )
      ).rowCount,
    ).toBe(0);
    expect(
      (
        await owner.query(
          "SELECT payload FROM events WHERE execution_id = $1 AND type = 'queue.cancelled'",
          [stale.executionId],
        )
      ).rows,
    ).toMatchObject([
      { payload: { expected_version: "0", observed_version: "1" } },
    ]);
  });

  it.each(["verifying", "awaiting_approval", "failed"] as const)(
    "acknowledges into %s and releases the lease",
    async (outcome) => {
      const queued = await enqueue();
      const leased = await queue.dequeue(identity, claim);
      if (!leased) throw new Error("Missing dispatch");
      const input = {
        id: leased.id,
        workerId: claim.workerId,
        fence: leased.fence,
        expectedVersion: leased.executionVersion,
        outcome,
      };
      expect(await queue.ack(identity, input)).toMatchObject({
        status: "acknowledged",
        expiresAt: null,
      });
      expect(
        (
          await owner.query(
            "SELECT state, version FROM executions WHERE id = $1",
            [queued.executionId],
          )
        ).rows,
      ).toEqual([{ state: outcome, version: "2" }]);
      expect((await owner.query("SELECT * FROM worker_leases")).rowCount).toBe(
        0,
      );
      await expect(queue.ack(identity, input)).rejects.toBeInstanceOf(
        QueueConflictError,
      );
      const events = await owner.query(
        "SELECT sequence, type FROM events WHERE execution_id = $1 ORDER BY sequence",
        [queued.executionId],
      );
      expect(events.rows).toEqual([
        { sequence: "0", type: "queue.enqueued" },
        { sequence: "1", type: "execution.started" },
        { sequence: "2", type: `execution.${outcome}` },
      ]);
      expect((await owner.query("SELECT * FROM outbox")).rowCount).toBe(3);
    },
  );

  it("rejects the wrong worker, fence, version and revoked lease without mutation", async () => {
    await enqueue();
    const leased = await queue.dequeue(identity, claim);
    if (!leased) throw new Error("Missing dispatch");
    const input = {
      id: leased.id,
      workerId: claim.workerId,
      fence: leased.fence,
      expectedVersion: leased.executionVersion,
      outcome: "verifying" as const,
    };
    for (const change of [
      { workerId: "intruder" },
      { fence: 2 },
      { expectedVersion: 0 },
    ]) {
      await expect(
        queue.ack(identity, { ...input, ...change }),
      ).rejects.toBeInstanceOf(QueueConflictError);
    }
    await owner.query("DELETE FROM worker_leases");
    await expect(queue.ack(identity, input)).rejects.toThrow("revoked");
    expect((await owner.query("SELECT state FROM executions")).rows).toEqual([
      { state: "running" },
    ]);
  });

  it("expires leases once, fences stale acknowledgements and requires reconciliation", async () => {
    const queued = await enqueue();
    const leased = await queue.dequeue(identity, claim);
    if (!leased) throw new Error("Missing dispatch");
    expect(await queue.timeout(identity)).toEqual([]);
    await expire(leased.id);
    const input = {
      id: leased.id,
      workerId: claim.workerId,
      fence: leased.fence,
      expectedVersion: leased.executionVersion,
      outcome: "verifying" as const,
    };
    await expect(queue.ack(identity, input)).rejects.toThrow("expired");
    const timeouts = await Promise.all([
      queue.timeout(identity),
      queue.timeout(identity),
    ]);
    expect(timeouts.flat()).toMatchObject([
      { id: leased.id, status: "timed_out", expiresAt: null },
    ]);
    expect(
      (await owner.query("SELECT state, version FROM executions")).rows,
    ).toEqual([{ state: "needs_reconciliation", version: "2" }]);
    expect((await owner.query("SELECT * FROM worker_leases")).rowCount).toBe(0);
    await expect(queue.ack(identity, input)).rejects.toBeInstanceOf(
      QueueConflictError,
    );
    expect(await queue.dequeue(identity, claim)).toBeNull();
    expect(
      await queue.enqueue(identity, {
        executionId: queued.executionId,
        expectedVersion: 0,
      }),
    ).toMatchObject({ status: "timed_out" });
    // Retry uses a new Execution for the same Work.
    await enqueue(0, queued.workId);
    expect(await queue.dequeue(identity, claim)).toMatchObject({
      workId: queued.workId,
      fence: 1,
    });
  });

  it("bounds timeout batches and leaves unexpired leases intact", async () => {
    const a = await enqueue();
    const b = await enqueue();
    await enqueue();
    for (let i = 0; i < 3; i++) await queue.dequeue(identity, claim);
    await expire(a.id);
    await expire(b.id);
    expect(await queue.timeout(identity, 1)).toHaveLength(1);
    expect(await queue.timeout(identity, 1)).toHaveLength(1);
    expect(await queue.timeout(identity, 1)).toEqual([]);
    expect((await owner.query("SELECT * FROM worker_leases")).rowCount).toBe(1);
  });

  it("honors cancellation before dispatch and after claim without reviving the execution", async () => {
    const pending = await enqueue(10);
    const running = await enqueue();
    await owner.query(
      "UPDATE executions SET state = 'cancelling', version = version + 1 WHERE id = $1",
      [pending.executionId],
    );
    expect((await queue.dequeue(identity, claim))?.id).toBe(running.id);
    expect(
      (
        await owner.query("SELECT status FROM work_queue WHERE id = $1", [
          pending.id,
        ])
      ).rows,
    ).toEqual([{ status: "cancelled" }]);
    await owner.query(
      "UPDATE executions SET state = 'cancelling', version = version + 1 WHERE id = $1",
      [running.executionId],
    );
    await owner.query("DELETE FROM worker_leases");
    await expire(running.id);
    expect(await queue.timeout(identity)).toMatchObject([
      { id: running.id, status: "cancelled" },
    ]);
    expect((await owner.query("SELECT state FROM executions")).rows).toEqual([
      { state: "cancelling" },
      { state: "cancelling" },
    ]);
  });

  it("enforces RLS, including direct queries, and forbids cross-tenant references", async () => {
    const queued = await enqueue();
    const other = { tenantId: randomUUID(), actorId: randomUUID() };
    expect(await queue.dequeue(other, claim)).toBeNull();
    expect(await queue.timeout(other)).toEqual([]);
    await expect(
      queue.enqueue(other, {
        executionId: queued.executionId,
        expectedVersion: 0,
      }),
    ).rejects.toBeInstanceOf(QueueConflictError);
    await expect(
      queue.ack(other, {
        id: queued.id,
        workerId: claim.workerId,
        fence: 1,
        expectedVersion: 1,
        outcome: "verifying",
      }),
    ).rejects.toBeInstanceOf(QueueConflictError);
    expect((await runtime.query("SELECT * FROM work_queue")).rows).toEqual([]);
    await database.withTenant(other, async (client) => {
      expect((await client.query("SELECT * FROM work_queue")).rows).toEqual([]);
      await expect(
        client.query(
          "INSERT INTO work_queue (tenant_id, work_id, execution_id, execution_version) VALUES ($1, $2, $3, 0)",
          [identity.tenantId, queued.workId, queued.executionId],
        ),
      ).rejects.toMatchObject({ code: "42501" });
    });
    const otherWork = await execution();
    await expect(
      owner.query(
        "INSERT INTO work_queue (tenant_id, work_id, execution_id, execution_version) VALUES ($1, $2, $3, 0)",
        [identity.tenantId, queued.workId, otherWork],
      ),
    ).rejects.toMatchObject({ code: "23503" });
  });

  it("rejects stale enqueue versions and unavailable Work states", async () => {
    const executionId = await execution();
    await expect(
      queue.enqueue(identity, { executionId, expectedVersion: 1 }),
    ).rejects.toBeInstanceOf(QueueConflictError);
    await owner.query("UPDATE works SET state = 'paused'");
    await expect(
      queue.enqueue(identity, { executionId, expectedVersion: 0 }),
    ).rejects.toBeInstanceOf(QueueConflictError);
    expect((await owner.query("SELECT * FROM work_queue")).rowCount).toBe(0);
  });

  it("rolls back claim, states and lease when event persistence fails", async () => {
    const queued = await enqueue();
    await owner.query(
      `CREATE FUNCTION fail_outbox() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'outbox unavailable'; END $$`,
    );
    await owner.query(
      "CREATE TRIGGER fail_outbox BEFORE INSERT ON outbox FOR EACH ROW EXECUTE FUNCTION fail_outbox()",
    );
    try {
      await expect(queue.dequeue(identity, claim)).rejects.toThrow(
        "outbox unavailable",
      );
      expect((await owner.query("SELECT status FROM work_queue")).rows).toEqual(
        [{ status: "queued" }],
      );
      expect(
        (await owner.query("SELECT state, version FROM executions")).rows,
      ).toEqual([{ state: "queued", version: "0" }]);
      expect(
        (await owner.query("SELECT state, version FROM works")).rows,
      ).toEqual([{ state: "open", version: "0" }]);
      expect((await owner.query("SELECT * FROM worker_leases")).rowCount).toBe(
        0,
      );
      expect((await owner.query("SELECT * FROM events")).rowCount).toBe(1);
    } finally {
      await owner.query(
        "DROP TRIGGER fail_outbox ON outbox; DROP FUNCTION fail_outbox()",
      );
    }
    expect((await queue.dequeue(identity, claim))?.id).toBe(queued.id);
  });

  it("rolls the queue migration down and reapplies it", async () => {
    await enqueue();
    expect(await migrateDown(owner)).toBe("20261015_003_work_queue");
    expect(
      (await owner.query("SELECT to_regclass('work_queue') AS name")).rows,
    ).toEqual([{ name: null }]);
    expect(await migrateUp(owner)).toEqual(["20261015_003_work_queue"]);
  });
});
