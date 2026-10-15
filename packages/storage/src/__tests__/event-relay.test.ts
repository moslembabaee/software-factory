import { randomUUID } from "node:crypto";
import type pg from "pg";
import { describe, expect, it, vi } from "vitest";
import type { EventPublisher } from "@software-factory/events";
import type { TenantDatabase } from "../database.js";
import { PostgresEventRelay } from "../event-relay.js";

const identity = { tenantId: randomUUID(), actorId: randomUUID() };
function fixture() {
  let transactionOpen = false;
  const row = {
    outbox_id: randomUUID(),
    id: randomUUID(),
    tenant_id: identity.tenantId,
    execution_id: randomUUID(),
    sequence: "0",
    type: "queue.enqueued",
    payload: {},
    occurred_at: new Date(),
  };
  const query = vi
    .fn<
      (
        sql: string,
        values?: unknown[],
      ) => Promise<{ rows: Record<string, unknown>[] }>
    >()
    .mockResolvedValue({ rows: [] });
  query.mockResolvedValueOnce({ rows: [row] });
  const database: TenantDatabase = {
    withTenant: async (_identity, operation) => {
      transactionOpen = true;
      try {
        return await operation({ query } as unknown as pg.PoolClient);
      } finally {
        transactionOpen = false;
      }
    },
  };
  const publisher = {
    publish: vi.fn<EventPublisher["publish"]>(() => {
      expect(transactionOpen).toBe(false);
      return Promise.resolve();
    }),
  };
  return {
    row,
    query,
    publisher,
    relay: new PostgresEventRelay(database, publisher),
  };
}

describe("durable event delivery", () => {
  it("commits a fenced claim before publishing, then acknowledges that same token", async () => {
    const f = fixture();
    f.query.mockResolvedValueOnce({ rows: [] }); // claim update
    f.query.mockResolvedValueOnce({ rows: [{ id: f.row.outbox_id }] }); // ack
    expect(await f.relay.flush(identity, { limit: 1 })).toBe(1);
    expect(f.publisher.publish).toHaveBeenCalledWith(
      expect.objectContaining({
        id: f.row.id,
        tenantId: identity.tenantId,
        executionId: f.row.execution_id,
        sequence: 0,
      }),
    );
    const claim = f.query.mock.calls[1];
    const ack = f.query.mock.calls[2];
    expect(claim?.[0]).toContain("attempts = attempts + 1");
    expect(ack?.[1]).toEqual([f.row.outbox_id, claim?.[1]?.[1]]);
    expect(ack?.[0]).toContain("delivery_expires_at > clock_timestamp()");
    expect(f.query.mock.calls[0]?.[0]).toContain("SKIP LOCKED");
    expect(f.query.mock.calls[0]?.[0]).toContain(
      "earlier.sequence < e.sequence",
    );
  });

  it("releases only its own delivery on consumer failure without marking it published", async () => {
    const f = fixture();
    f.publisher.publish.mockRejectedValue(new Error("consumer unavailable"));
    await expect(f.relay.flush(identity, { limit: 1 })).rejects.toThrow(
      "consumer unavailable",
    );
    const release = f.query.mock.calls.at(-1);
    expect(release?.[0]).toContain("delivery_token = $2");
    expect(release?.[0]).not.toContain("published_at = clock_timestamp()");
  });

  it("rejects stale acknowledgements and does not clear another worker's token", async () => {
    const f = fixture();
    await expect(f.relay.flush(identity, { limit: 1 })).rejects.toThrow(
      "lease expired or changed",
    );
    expect(f.query.mock.calls.at(-1)?.[1]).toEqual(f.query.mock.calls[2]?.[1]);
  });

  it("rejects unrecognized events before publishing and keeps them retryable", async () => {
    const f = fixture();
    f.row.type = "unknown";
    await expect(f.relay.flush(identity, { limit: 1 })).rejects.toThrow();
    expect(f.publisher.publish).not.toHaveBeenCalled();
    expect(f.query.mock.calls.at(-1)?.[0]).toContain("delivery_token = NULL");
  });

  it("keeps a failed execution pending while delivering unrelated executions", async () => {
    const f = fixture();
    const other = {
      ...f.row,
      outbox_id: randomUUID(),
      id: randomUUID(),
      execution_id: randomUUID(),
    };
    f.publisher.publish.mockRejectedValueOnce(new Error("source unavailable"));
    f.query.mockResolvedValueOnce({ rows: [] }); // first claim
    f.query.mockResolvedValueOnce({ rows: [] }); // release failed delivery
    f.query.mockResolvedValueOnce({ rows: [other] }); // next execution
    f.query.mockResolvedValueOnce({ rows: [] }); // next claim
    f.query.mockResolvedValueOnce({ rows: [{ id: other.outbox_id }] }); // ack

    await expect(f.relay.flush(identity)).rejects.toThrow("source unavailable");
    expect(
      f.publisher.publish.mock.calls.map(([event]) => event.executionId),
    ).toEqual([f.row.execution_id, other.execution_id]);
    expect(f.query.mock.calls[3]?.[0]).toContain(
      "NOT (e.execution_id = ANY($2::uuid[]))",
    );
    expect(f.query.mock.calls[3]?.[1]).toEqual([
      identity.tenantId,
      [f.row.execution_id],
    ]);
    const acknowledgements = f.query.mock.calls.filter(([sql]) =>
      sql.includes("SET published_at = clock_timestamp()"),
    );
    expect(acknowledgements).toHaveLength(1);
    expect(acknowledgements[0]?.[1]?.[0]).toBe(other.outbox_id);
  });

  it("bounds failed attempts and reports failures from multiple executions", async () => {
    const f = fixture();
    const other = { ...f.row, execution_id: randomUUID(), id: randomUUID() };
    const firstError = new Error("first source unavailable");
    const secondError = new Error("second source unavailable");
    f.publisher.publish.mockRejectedValueOnce(firstError);
    f.publisher.publish.mockRejectedValueOnce(secondError);
    f.query.mockResolvedValueOnce({ rows: [] }); // first claim
    f.query.mockResolvedValueOnce({ rows: [] }); // first release
    f.query.mockResolvedValueOnce({ rows: [other] });
    f.query.mockResolvedValueOnce({ rows: [] }); // second claim
    f.query.mockResolvedValueOnce({ rows: [] }); // second release

    await expect(f.relay.flush(identity, { limit: 2 })).rejects.toMatchObject({
      name: "AggregateError",
      errors: [firstError, secondError],
    });
    expect(f.publisher.publish).toHaveBeenCalledTimes(2);
    expect(f.query).toHaveBeenCalledTimes(6);
  });

  it.each([
    { limit: 0 },
    { limit: 1001 },
    { leaseMs: 0 },
    { leaseMs: Infinity },
  ])("rejects invalid limits", async (options) => {
    const f = fixture();
    await expect(f.relay.flush(identity, options)).rejects.toBeInstanceOf(
      TypeError,
    );
    expect(f.query).not.toHaveBeenCalled();
  });
});
