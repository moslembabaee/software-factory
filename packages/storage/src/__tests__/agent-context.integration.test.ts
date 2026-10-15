/** Disposable PostgreSQL database, non-bypass runtime role, actual crash/timeout transactions. */
import { randomBytes, randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PostgresDatabase } from "../database.js";
import type { TenantIdentity } from "../database.js";
import { PostgresAgentContext } from "../agent-context.js";
import type { AgentContext, SaveAgentCheckpoint } from "../agent-context.js";
import { PostgresExecutionHistory } from "../execution-history.js";
import { PostgresWorkQueue } from "../work-queue.js";
import { migrateDown, migrateUp } from "../migrate.js";

function required<T>(value: T | null | undefined): T {
  if (value === undefined || value === null)
    throw new Error("Missing test fixture");
  return value;
}

const url = process.env["TEST_DATABASE_URL"];
const suffix = randomBytes(8).toString("hex");
const databaseName = `sf_context_${suffix}`;
const roleName = `sf_context_role_${suffix}`;
const context: AgentContext = {
  schemaVersion: 1,
  baseSha: "a".repeat(40),
  policyVersion: "p1",
  modelProfile: "coding",
  messages: [
    { role: "user", content: "Fix login" },
    { role: "assistant", content: "Login tests now pass" },
  ],
  summary: null,
  metadata: { testEvidence: "artifact-reference" },
};

describe.skipIf(!url).sequential("PostgreSQL agent context recovery", () => {
  let admin: pg.Pool | undefined;
  let owner: pg.Pool | undefined;
  let runtime: pg.Pool | undefined;
  let created = false;
  let roleCreated = false;
  let database: PostgresDatabase;
  let store: PostgresAgentContext;
  let queue: PostgresWorkQueue;
  let identity: TenantIdentity;
  let input: SaveAgentCheckpoint;

  beforeAll(async () => {
    if (!url) throw new Error("TEST_DATABASE_URL required");
    admin = new pg.Pool({
      connectionString: url,
      connectionTimeoutMillis: 5000,
    });
    await admin.query(`CREATE DATABASE ${databaseName}`);
    created = true;
    await admin.query(
      `CREATE ROLE ${roleName} NOLOGIN NOSUPERUSER NOBYPASSRLS`,
    );
    roleCreated = true;
    const connection = new URL(url);
    connection.pathname = `/${databaseName}`;
    owner = new pg.Pool({
      connectionString: connection.href,
      connectionTimeoutMillis: 5000,
    });
    await migrateUp(owner);
    await owner.query(`GRANT USAGE ON SCHEMA public TO ${roleName}`);
    await owner.query(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${roleName}`,
    );
    runtime = new pg.Pool({
      connectionString: connection.href,
      options: `-c role=${roleName}`,
      max: 8,
      connectionTimeoutMillis: 5000,
    });
    database = new PostgresDatabase(runtime);
    store = new PostgresAgentContext(database);
    queue = new PostgresWorkQueue(database);
  }, 20000);

  beforeEach(async () => {
    if (!owner) throw new Error("Database unavailable");
    await owner.query("TRUNCATE tenants CASCADE");
    identity = { tenantId: randomUUID(), actorId: randomUUID() };
    const projectId = randomUUID();
    const workId = randomUUID();
    const executionId = randomUUID();
    await owner.query("INSERT INTO tenants (id, name) VALUES ($1, 'context')", [
      identity.tenantId,
    ]);
    await owner.query(
      "INSERT INTO actors (id, tenant_id, subject) VALUES ($1, $2, 'worker')",
      [identity.actorId, identity.tenantId],
    );
    await owner.query(
      "INSERT INTO projects (id, tenant_id, name) VALUES ($1, $2, 'context')",
      [projectId, identity.tenantId],
    );
    await owner.query(
      "INSERT INTO works (id, tenant_id, project_id, created_by, objective) VALUES ($1, $2, $3, $4, 'fix')",
      [workId, identity.tenantId, projectId, identity.actorId],
    );
    await owner.query(
      "INSERT INTO executions (id, tenant_id, work_id, budget_cap_usd) VALUES ($1, $2, $3, 10)",
      [executionId, identity.tenantId, workId],
    );
    await queue.enqueue(identity, { executionId, expectedVersion: 0 });
    const claim = await queue.dequeue(identity, {
      workerId: "lost-worker",
      leaseMs: 60_000,
      executionId,
    });
    if (!claim) throw new Error("Missing claim");
    input = {
      id: randomUUID(),
      executionId,
      workerId: "lost-worker",
      fence: claim.fence,
      expectedVersion: claim.executionVersion,
      expectedSequence: 0,
      step: 3,
      context,
    };
  });

  afterAll(async () => {
    await runtime?.end();
    await owner?.end();
    try {
      if (created)
        await required(admin).query(
          `DROP DATABASE ${databaseName} WITH (FORCE)`,
        );
      if (roleCreated) await required(admin).query(`DROP ROLE ${roleName}`);
    } finally {
      await admin?.end();
    }
  });

  async function crash(): Promise<void> {
    // No process memory is transferred; only the committed checkpoint survives.
    await required(owner).query(
      "UPDATE work_queue SET expires_at = clock_timestamp() - interval '1 second' WHERE execution_id = $1",
      [input.executionId],
    );
    await required(owner).query(
      "UPDATE worker_leases SET expires_at = clock_timestamp() - interval '1 second' WHERE execution_id = $1",
      [input.executionId],
    );
    await queue.timeout(identity);
  }

  async function recover() {
    return store.recover(identity, {
      ...context,
      executionId: input.executionId,
      expectedVersion: 2,
    });
  }

  it("survives process restart, resumes the selected conversation in a fresh execution and preserves task history", async () => {
    const saved = await store.save(identity, input);
    expect(
      await new PostgresAgentContext(database).latest(
        identity,
        input.executionId,
      ),
    ).toEqual(saved);
    await crash();
    const ids = await Promise.all(Array.from({ length: 6 }, recover));
    expect(new Set(ids).size).toBe(1);
    const childId = required(ids[0]);
    const restarted = new PostgresAgentContext(database);
    expect(await restarted.restore(identity, childId, context)).toEqual(saved);
    const history = new PostgresExecutionHistory(database);
    const child = await history.get(identity, childId);
    expect(child).toMatchObject({
      workId: saved.workId,
      parentExecutionId: input.executionId,
      state: "queued",
      version: 0,
    });
    expect(await history.get(identity, input.executionId)).toMatchObject({
      state: "needs_reconciliation",
      version: 2,
    });
    await expect(
      store.save(identity, {
        ...input,
        id: randomUUID(),
        expectedSequence: 1,
        step: 4,
      }),
    ).rejects.toThrow("running version");
    await queue.enqueue(identity, { executionId: childId, expectedVersion: 0 });
    const claim = await queue.dequeue(identity, {
      workerId: "new-worker",
      leaseMs: 60_000,
      executionId: childId,
    });
    expect(claim).not.toBeNull();
    const next = {
      ...input,
      id: randomUUID(),
      executionId: childId,
      workerId: "new-worker",
      step: 4,
    };
    await expect(
      restarted.save(identity, { ...next, step: 3 }),
    ).rejects.toThrow("step must advance");
    expect(await restarted.save(identity, next)).toMatchObject({
      executionId: childId,
      sequence: 1,
      step: 4,
    });
    expect(
      (await history.list(identity, input.executionId)).map(
        (event) => event.type,
      ),
    ).toEqual([
      "queue.enqueued",
      "execution.dispatched",
      "execution.started",
      "agent.checkpoint.created",
      "queue.timed_out",
      "agent.checkpoint.recovered",
    ]);
    expect((await history.list(identity, childId))[0]?.payload).toMatchObject({
      checkpoint_id: saved.id,
    });
  });

  it("serializes concurrent checkpoint writes, deduplicates retries and rejects stale owners", async () => {
    const outcomes = await Promise.allSettled([
      store.save(identity, input),
      store.save(identity, { ...input, id: randomUUID() }),
    ]);
    expect(
      outcomes.filter((entry) => entry.status === "fulfilled"),
    ).toHaveLength(1);
    const saved = await store.latest(identity, input.executionId);
    expect(saved).not.toBeNull();
    const retry = { ...input, id: required(saved).id };
    expect(await store.save(identity, retry)).toEqual(saved);
    for (const change of [
      { fence: 2 },
      { workerId: "intruder" },
      { expectedVersion: 2 },
    ]) {
      await expect(
        store.save(identity, { ...input, ...change }),
      ).rejects.toThrow();
    }
    expect(
      (await required(owner).query("SELECT * FROM agent_checkpoints")).rows,
    ).toHaveLength(1);
    expect(
      (
        await required(owner).query(
          "SELECT * FROM events WHERE type = 'agent.checkpoint.created'",
        )
      ).rows,
    ).toHaveLength(1);
  });

  it.each(["prepared", "dispatched", "confirmed", "unknown", "manual_review"])(
    "blocks recovery when a %s external effect could be replayed",
    async (status) => {
      await store.save(identity, input);
      await required(owner).query(
        "INSERT INTO external_effects (tenant_id, execution_id, provider, action_digest, status, fence) VALUES ($1, $2, 'git', $3, $4, 1)",
        [identity.tenantId, input.executionId, "a".repeat(64), status],
      );
      await crash();
      await expect(recover()).rejects.toThrow("effects, approvals");
      expect(
        (await required(owner).query("SELECT * FROM agent_recoveries")).rows,
      ).toEqual([]);
    },
  );

  it("blocks recovery for a changed base/policy/model or exhausted budget", async () => {
    await store.save(identity, input);
    await crash();
    for (const change of [
      { baseSha: "b".repeat(40) },
      { policyVersion: "p2" },
      { modelProfile: "other" },
    ]) {
      await expect(
        store.recover(identity, {
          ...context,
          ...change,
          executionId: input.executionId,
          expectedVersion: 2,
        }),
      ).rejects.toThrow("has changed");
    }
    await required(owner).query(
      "UPDATE executions SET spent_usd = budget_cap_usd WHERE id = $1",
      [input.executionId],
    );
    await expect(recover()).rejects.toThrow("available budget");
  });

  it("enforces RLS and append-only context even through direct SQL", async () => {
    await store.save(identity, input);
    await crash();
    const childId = await recover();
    const other = { tenantId: randomUUID(), actorId: randomUUID() };
    expect(await store.latest(other, input.executionId)).toBeNull();
    expect(await store.restore(other, childId, context)).toBeNull();
    await expect(store.save(other, input)).rejects.toThrow("running version");
    await expect(
      store.recover(other, {
        ...context,
        executionId: input.executionId,
        expectedVersion: 2,
      }),
    ).rejects.toThrow("unavailable");
    expect(
      (await required(runtime).query("SELECT * FROM agent_checkpoints")).rows,
    ).toEqual([]);
    expect(
      (await required(runtime).query("SELECT * FROM agent_recoveries")).rows,
    ).toEqual([]);
    await expect(
      database.withTenant(identity, (client) =>
        client.query("UPDATE agent_checkpoints SET step = 99"),
      ),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      database.withTenant(identity, (client) =>
        client.query("DELETE FROM agent_recoveries"),
      ),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      database.withTenant(other, (client) =>
        client.query(
          "INSERT INTO agent_recoveries (tenant_id, source_execution_id, execution_id, checkpoint_id) VALUES ($1, $2, $3, $4)",
          [identity.tenantId, input.executionId, childId, input.id],
        ),
      ),
    ).rejects.toMatchObject({ code: "42501" });
  });

  it("rolls checkpoint, run pointer and recovery back if their outbox write fails", async () => {
    await required(owner).query(
      "CREATE FUNCTION fail_context_outbox() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'outbox unavailable'; END $$",
    );
    await required(owner).query(
      "CREATE TRIGGER fail_context_outbox BEFORE INSERT ON outbox FOR EACH ROW EXECUTE FUNCTION fail_context_outbox()",
    );
    try {
      await expect(store.save(identity, input)).rejects.toThrow(
        "outbox unavailable",
      );
      expect(await store.latest(identity, input.executionId)).toBeNull();
      expect(
        (await required(owner).query("SELECT * FROM agent_runs")).rows,
      ).toEqual([]);
    } finally {
      await required(owner).query("DROP TRIGGER fail_context_outbox ON outbox");
    }
    await store.save(identity, input);
    await crash();
    await required(owner).query(
      "CREATE TRIGGER fail_context_outbox BEFORE INSERT ON outbox FOR EACH ROW EXECUTE FUNCTION fail_context_outbox()",
    );
    try {
      await expect(recover()).rejects.toThrow("outbox unavailable");
      expect(
        (await required(owner).query("SELECT * FROM agent_recoveries")).rows,
      ).toEqual([]);
      expect(
        (await required(owner).query("SELECT * FROM executions")).rows,
      ).toHaveLength(1);
    } finally {
      await required(owner).query("DROP TRIGGER fail_context_outbox ON outbox");
      await required(owner).query("DROP FUNCTION fail_context_outbox()");
    }
    expect(await recover()).toBeTypeOf("string");
  });

  it("reverts and reapplies checkpoint storage", async () => {
    await store.save(identity, input);
    expect(await migrateDown(required(owner))).toBe(
      "20261015_005_agent_checkpoints",
    );
    expect(
      (
        await required(owner).query(
          "SELECT to_regclass('agent_checkpoints') AS name",
        )
      ).rows,
    ).toEqual([{ name: null }]);
    expect(await migrateUp(required(owner))).toEqual([
      "20261015_005_agent_checkpoints",
    ]);
  });
});
