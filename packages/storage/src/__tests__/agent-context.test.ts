import { randomUUID } from "node:crypto";
import type pg from "pg";
import { describe, expect, it, vi } from "vitest";
import type { TenantDatabase } from "../database.js";
import {
  CheckpointConflictError,
  PostgresAgentContext,
} from "../agent-context.js";
import type { AgentContext, SaveAgentCheckpoint } from "../agent-context.js";

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Missing test fixture");
  return value;
}

const identity = { tenantId: randomUUID(), actorId: randomUUID() };
const workId = randomUUID();
const executionId = randomUUID();
const context: AgentContext = {
  schemaVersion: 1,
  baseSha: "a".repeat(40),
  policyVersion: "p1",
  modelProfile: "coding",
  messages: [
    { role: "user", content: "Fix login" },
    { role: "tool", content: "Tests pass", toolCallId: "test-1" },
  ],
  summary: "Inspected login; retain acceptance tests",
  metadata: { artifacts: ["artifact-id"] },
};
const input: SaveAgentCheckpoint = {
  id: randomUUID(),
  executionId,
  expectedSequence: 0,
  expectedVersion: 1,
  workerId: "worker",
  fence: 1,
  step: 2,
  context,
};
const row = {
  id: input.id,
  tenant_id: identity.tenantId,
  work_id: workId,
  execution_id: executionId,
  sequence: "1",
  step: 2,
  worker_id: "worker",
  fence: "1",
  context,
  created_at: new Date("2026-10-15T00:00:00Z"),
};

function fixture() {
  const query = vi
    .fn<
      (
        sql: string,
        values?: unknown[],
      ) => Promise<{ rows: Record<string, unknown>[] }>
    >()
    .mockImplementation((sql) => {
      if (sql.startsWith("SELECT work_id"))
        return Promise.resolve({
          rows: [{ work_id: workId, state: "running", version: "1" }],
        });
      if (sql.includes("SELECT q.id"))
        return Promise.resolve({ rows: [{ id: randomUUID() }] });
      if (sql.startsWith("INSERT INTO agent_checkpoints"))
        return Promise.resolve({ rows: [row] });
      if (sql.includes("INSERT INTO events"))
        return Promise.resolve({ rows: [{ id: randomUUID() }] });
      return Promise.resolve({ rows: [] });
    });
  const database: TenantDatabase = {
    withTenant: (_identity, operation) =>
      operation({ query } as unknown as pg.PoolClient),
  };
  const withTenant = vi.spyOn(database, "withTenant");
  return {
    database,
    withTenant,
    query,
    store: new PostgresAgentContext(database),
  };
}

describe("agent checkpoints", () => {
  it("persists finalized conversation, run pointer, event and outbox within one tenant transaction", async () => {
    const f = fixture();
    expect(await f.store.save(identity, input)).toMatchObject({
      id: input.id,
      context,
      sequence: 1,
      step: 2,
      tenantId: identity.tenantId,
      workId,
    });
    expect(f.withTenant).toHaveBeenCalledWith(identity, expect.any(Function));
    const insert = f.query.mock.calls.find(([sql]) =>
      sql.startsWith("INSERT INTO agent_checkpoints"),
    );
    expect(JSON.parse(String(insert?.[1]?.[8]))).toEqual(context);
    expect(
      f.query.mock.calls.find(([sql]) =>
        sql.includes("INSERT INTO agent_runs"),
      )?.[1],
    ).toEqual([identity.tenantId, executionId, 2, input.id]);
    const audit = f.query.mock.calls.find(([sql]) =>
      sql.includes("INSERT INTO events"),
    );
    expect(audit?.[1]?.[2]).toBe("agent.checkpoint.created");
    expect(String(audit?.[1]?.[3])).not.toContain("Fix login");
    expect(f.query.mock.calls.at(-1)?.[0]).toContain("INSERT INTO outbox");
  });

  it.each([
    "queued",
    "verifying",
    "cancelling",
    "needs_reconciliation",
    "completed",
  ])("rejects checkpoint writes from %s", async (state) => {
    const f = fixture();
    f.query.mockResolvedValueOnce({
      rows: [{ work_id: workId, state, version: "1" }],
    });
    await expect(f.store.save(identity, input)).rejects.toBeInstanceOf(
      CheckpointConflictError,
    );
    expect(f.query).toHaveBeenCalledOnce();
  });

  it("rejects a stale execution version and expired/revoked/wrong-worker lease before writing", async () => {
    for (const rows of [
      [],
      [{ work_id: workId, state: "running", version: "2" }],
    ]) {
      const f = fixture();
      f.query.mockResolvedValueOnce({ rows });
      await expect(f.store.save(identity, input)).rejects.toThrow(
        "running version",
      );
    }
    const f = fixture();
    f.query.mockResolvedValueOnce({
      rows: [{ work_id: workId, state: "running", version: "1" }],
    });
    f.query.mockResolvedValueOnce({ rows: [] });
    await expect(f.store.save(identity, input)).rejects.toThrow(
      "lease expired",
    );
    expect(f.query.mock.calls.at(-1)?.[0]).toContain(
      "l.expires_at > clock_timestamp()",
    );
    expect(f.query.mock.calls.at(-1)?.[1]).toEqual([
      identity.tenantId,
      executionId,
      "worker",
      1,
      1,
    ]);
    expect(f.query.mock.calls.some(([sql]) => sql.startsWith("INSERT"))).toBe(
      false,
    );
  });

  it("deduplicates identical checkpoint writes and rejects changed content and stale sequences", async () => {
    for (const change of [
      {},
      { context: { ...context, summary: "Changed" } },
      { id: randomUUID() },
    ]) {
      const f = fixture();
      const original = f.query.getMockImplementation();
      f.query.mockImplementation((sql, values) =>
        sql.startsWith("SELECT * FROM agent_checkpoints")
          ? Promise.resolve({ rows: [row] })
          : required(original)(sql, values),
      );
      const promise = f.store.save(identity, { ...input, ...change });
      if (!Object.keys(change).length)
        await expect(promise).resolves.toMatchObject({ id: input.id });
      else
        await expect(promise).rejects.toBeInstanceOf(CheckpointConflictError);
      expect(f.query.mock.calls.some(([sql]) => sql.startsWith("INSERT"))).toBe(
        false,
      );
    }
  });

  it.each([
    { expectedSequence: -1 },
    { expectedVersion: 1.5 },
    { fence: 0 },
    { workerId: " " },
    { step: Infinity },
    { step: 2_147_483_648 },
    { id: "bad" },
    { context: { ...context, schemaVersion: 2 } },
    { context: { ...context, baseSha: "bad" } },
    { context: { ...context, messages: [{ role: "bad", content: "x" }] } },
    { context: { ...context, metadata: { bad: NaN } } },
    { context: { ...context, summary: "x".repeat(1_048_576) } },
  ])(
    "validates malformed input before opening a transaction: %j",
    async (change) => {
      const f = fixture();
      await expect(
        f.store.save(identity, { ...input, ...change } as SaveAgentCheckpoint),
      ).rejects.toBeInstanceOf(TypeError);
      expect(f.withTenant).not.toHaveBeenCalled();
    },
  );

  it("restores from the selected ancestor checkpoint and refuses a changed binding", async () => {
    const f = fixture();
    f.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [row] });
    expect(
      await f.store.restore(identity, randomUUID(), context),
    ).toMatchObject({ context, executionId });
    f.query.mockResolvedValueOnce({ rows: [row] });
    await expect(
      f.store.restore(identity, executionId, {
        ...context,
        policyVersion: "p2",
      }),
    ).rejects.toThrow("has changed");
  });
});

describe("checkpoint recovery", () => {
  const recovery = { ...context, executionId, expectedVersion: 2 };
  const source = {
    work_id: workId,
    state: "needs_reconciliation",
    version: "2",
    work_state: "active",
    budget_ok: true,
  };

  function recoverFixture() {
    const f = fixture();
    const childId = randomUUID();
    const base = f.query.getMockImplementation();
    f.query.mockImplementation((sql, values) => {
      if (sql.includes("SELECT e.work_id"))
        return Promise.resolve({ rows: [source] });
      if (sql.startsWith("SELECT * FROM agent_checkpoints"))
        return Promise.resolve({ rows: [row] });
      if (sql.startsWith("INSERT INTO executions"))
        return Promise.resolve({ rows: [{ id: childId }] });
      return required(base)(sql, values);
    });
    return { ...f, childId };
  }

  it("creates a new linked execution and preserves the original attempt with durable recovery causation", async () => {
    const f = recoverFixture();
    expect(await f.store.recover(identity, recovery)).toBe(f.childId);
    const creation = f.query.mock.calls.find(([sql]) =>
      sql.startsWith("INSERT INTO executions"),
    );
    expect(creation?.[0]).toContain("budget_cap_usd - spent_usd");
    expect(
      f.query.mock.calls.find(([sql]) =>
        sql.includes("INSERT INTO agent_recoveries"),
      )?.[1],
    ).toEqual([identity.tenantId, executionId, f.childId, input.id]);
    expect(
      f.query.mock.calls
        .filter(([sql]) => sql.includes("INSERT INTO events"))
        .map(([, values]) => values?.[2]),
    ).toEqual(["agent.checkpoint.recovered", "execution.created"]);
    expect(
      f.query.mock.calls.some(([sql]) => sql.startsWith("UPDATE executions")),
    ).toBe(false);
  });

  it.each([
    { state: "running" },
    { state: "completed" },
    { version: "3" },
    { budget_ok: false },
    { work_state: "paused" },
  ])("blocks recovery from an ineligible source: %j", async (change) => {
    const f = recoverFixture();
    f.query.mockResolvedValueOnce({ rows: [{ ...source, ...change }] });
    await expect(f.store.recover(identity, recovery)).rejects.toThrow(
      "Recovery requires",
    );
    expect(f.query.mock.calls.some(([sql]) => sql.startsWith("INSERT"))).toBe(
      false,
    );
  });

  it("refuses recovery without a checkpoint or with effects/approvals requiring reconciliation", async () => {
    const f = recoverFixture();
    f.query
      .mockResolvedValueOnce({ rows: [source] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });
    await expect(f.store.recover(identity, recovery)).rejects.toThrow(
      "effects, approvals",
    );
    expect(f.query.mock.calls.at(-1)?.[0]).toContain("status <> 'rejected'");
    expect(f.query.mock.calls.at(-1)?.[0]).toContain(
      "NOT EXISTS (SELECT 1 FROM approvals",
    );
    const noCheckpoint = recoverFixture();
    const base = noCheckpoint.query.getMockImplementation();
    noCheckpoint.query.mockImplementation((sql, values) =>
      sql.startsWith("SELECT * FROM agent_checkpoints")
        ? Promise.resolve({ rows: [] })
        : required(base)(sql, values),
    );
    await expect(
      noCheckpoint.store.recover(identity, recovery),
    ).rejects.toThrow("No checkpoint");
  });

  it("deduplicates recovery requests but checks the caller's current context binding on replay", async () => {
    const f = recoverFixture();
    for (const current of [context, { ...context, baseSha: "b".repeat(40) }]) {
      f.query.mockResolvedValueOnce({ rows: [source] });
      f.query.mockResolvedValueOnce({
        rows: [{ execution_id: f.childId, context }],
      });
      const promise = f.store.recover(identity, { ...recovery, ...current });
      if (current === context) await expect(promise).resolves.toBe(f.childId);
      else await expect(promise).rejects.toThrow("has changed");
    }
    expect(f.query.mock.calls.some(([sql]) => sql.startsWith("INSERT"))).toBe(
      false,
    );
  });
});
