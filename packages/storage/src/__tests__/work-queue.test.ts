import { describe, expect, it, vi } from "vitest";
import type pg from "pg";
import type { TenantDatabase } from "../database.js";
import { PostgresWorkQueue, QueueConflictError } from "../work-queue.js";

const identity = {
  tenantId: "00000000-0000-4000-8000-000000000001",
  actorId: "00000000-0000-4000-8000-000000000002",
};
const executionId = "00000000-0000-4000-8000-000000000003";

function fixture() {
  const database: TenantDatabase = { withTenant: vi.fn() };
  const withTenant = vi.spyOn(database, "withTenant");
  return { withTenant, queue: new PostgresWorkQueue(database) };
}

describe("work queue input boundaries", () => {
  it.each([NaN, Infinity, 1.5, -2147483649, 2147483648])(
    "rejects invalid priority %s before opening a transaction",
    async (priority) => {
      const { withTenant, queue } = fixture();
      await expect(
        queue.enqueue(identity, { executionId, expectedVersion: 0, priority }),
      ).rejects.toBeInstanceOf(TypeError);
      expect(withTenant).not.toHaveBeenCalled();
    },
  );

  it.each([0, -1, 1.5, Infinity, 86400001])(
    "rejects invalid lease duration %s",
    async (leaseMs) => {
      const { withTenant, queue } = fixture();
      await expect(
        queue.dequeue(identity, { workerId: "worker", leaseMs }),
      ).rejects.toBeInstanceOf(TypeError);
      expect(withTenant).not.toHaveBeenCalled();
    },
  );

  it.each(["", "   ", "w".repeat(201)])(
    "rejects invalid worker IDs",
    async (workerId) => {
      const { withTenant, queue } = fixture();
      await expect(
        queue.dequeue(identity, { workerId, leaseMs: 1000 }),
      ).rejects.toBeInstanceOf(TypeError);
      expect(withTenant).not.toHaveBeenCalled();
    },
  );

  it.each([0, -1, 1.5, Infinity, 1001])(
    "rejects invalid timeout batch limit %s",
    async (limit) => {
      const { withTenant, queue } = fixture();
      await expect(queue.timeout(identity, limit)).rejects.toBeInstanceOf(
        TypeError,
      );
      expect(withTenant).not.toHaveBeenCalled();
    },
  );

  it("rejects invalid identifiers and unsafe counters", async () => {
    const { withTenant, queue } = fixture();
    await expect(
      queue.enqueue(identity, { executionId: "invalid", expectedVersion: 0 }),
    ).rejects.toBeInstanceOf(TypeError);
    await expect(
      queue.enqueue(identity, { executionId, expectedVersion: -1 }),
    ).rejects.toBeInstanceOf(TypeError);
    await expect(
      queue.ack(identity, {
        id: executionId,
        workerId: "worker",
        fence: 0,
        expectedVersion: 1,
        outcome: "verifying",
      }),
    ).rejects.toBeInstanceOf(TypeError);
    await expect(
      queue.ack(identity, {
        id: executionId,
        workerId: "worker",
        fence: 1,
        expectedVersion: Number.MAX_SAFE_INTEGER + 1,
        outcome: "verifying",
      }),
    ).rejects.toBeInstanceOf(TypeError);
    expect(withTenant).not.toHaveBeenCalled();
  });

  it("propagates database errors to callers", async () => {
    const { withTenant, queue } = fixture();
    withTenant.mockRejectedValue(new Error("database unavailable"));
    await expect(
      queue.dequeue(identity, { workerId: "worker", leaseMs: 1000 }),
    ).rejects.toThrow("database unavailable");
  });
});

// Exercise ownership and version guards even when live PostgreSQL is unavailable.
// Concurrency, persistence and RLS are covered by work-queue.integration.test.ts.
const leasedRow = {
  id: "00000000-0000-4000-8000-000000000004",
  tenant_id: identity.tenantId,
  work_id: "00000000-0000-4000-8000-000000000005",
  execution_id: executionId,
  priority: 0,
  status: "leased",
  worker_id: "worker",
  fence: "1",
  execution_version: "1",
  current_version: "1",
  execution_state: "running",
  work_state: "active",
  created_at: new Date("2026-10-15T00:00:00Z"),
  expires_at: new Date("2026-10-15T00:01:00Z"),
};

function selectedFixture(row: Record<string, unknown> | undefined) {
  const query = vi
    .fn<
      (
        sql: string,
        values?: unknown[],
      ) => Promise<{ rows: Record<string, unknown>[] }>
    >()
    .mockImplementation((sql) =>
      Promise.resolve({
        rows: sql.includes("INSERT INTO events") ? [{ id: executionId }] : [],
      }),
    )
    .mockResolvedValueOnce({ rows: row ? [row] : [] });
  const client = { query } as unknown as pg.PoolClient;
  const database: TenantDatabase = {
    withTenant: async (_identity, operation) => operation(client),
  };
  return { query, queue: new PostgresWorkQueue(database) };
}

describe("dispatch guards", () => {
  const acknowledgement = {
    id: leasedRow.id,
    workerId: "worker",
    fence: 1,
    expectedVersion: 1,
    outcome: "verifying" as const,
  };

  it.each([
    undefined,
    { ...leasedRow, status: "acknowledged" },
    { ...leasedRow, worker_id: "another-worker" },
    { ...leasedRow, fence: "2" },
    { ...leasedRow, current_version: "2" },
    { ...leasedRow, execution_version: "0" },
    { ...leasedRow, execution_state: "cancelling" },
  ])("rejects a stale acknowledgement without writing", async (row) => {
    const { queue, query } = selectedFixture(row);
    await expect(queue.ack(identity, acknowledgement)).rejects.toBeInstanceOf(
      QueueConflictError,
    );
    expect(query).toHaveBeenCalledOnce();
  });

  it("rejects an expired or revoked lease before changing queue or execution state", async () => {
    const { queue, query } = selectedFixture(leasedRow);
    await expect(queue.ack(identity, acknowledgement)).rejects.toThrow(
      "expired or been revoked",
    );
    expect(query.mock.calls.some(([sql]) => /^\s*UPDATE\b/.test(sql))).toBe(
      false,
    );
  });

  it.each([
    { execution_state: "cancelling" },
    { work_state: "paused" },
    { current_version: "2" },
  ])(
    "drains an ineligible dispatch without activating or leasing it",
    async (change) => {
      const row = {
        ...leasedRow,
        status: "queued",
        execution_state: "queued",
        worker_id: null,
        expires_at: null,
        ...change,
      };
      const { queue, query } = selectedFixture(row);
      await expect(
        queue.dequeue(identity, { workerId: "worker", leaseMs: 1000 }),
      ).resolves.toBeNull();
      const writes = query.mock.calls.filter(([sql]) =>
        /^\s*(UPDATE|INSERT|DELETE)\b/.test(sql),
      );
      expect(writes.some(([sql]) => sql.includes("status = 'cancelled'"))).toBe(
        true,
      );
      expect(
        writes.some(([sql]) =>
          /worker_leases|UPDATE executions|UPDATE works/.test(sql),
        ),
      ).toBe(false);
      const audit = writes.find(([sql]) => sql.includes("INSERT INTO events"));
      expect(audit?.[1]?.[2]).toBe("queue.cancelled");
      expect(JSON.parse(String(audit?.[1]?.[3]))).toMatchObject({
        actor_id: identity.actorId,
        expected_version: row.execution_version,
        observed_version: row.current_version,
      });
    },
  );
});
