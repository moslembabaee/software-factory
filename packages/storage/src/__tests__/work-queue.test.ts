import { describe, expect, it, vi } from "vitest";
import type { TenantDatabase } from "../database.js";
import { PostgresWorkQueue } from "../work-queue.js";

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
