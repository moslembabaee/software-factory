import type pg from "pg";
import { describe, expect, it, vi } from "vitest";
import { PostgresDatabase } from "../database.js";

const identity = {
  tenantId: "00000000-0000-4000-8000-000000000001",
  actorId: "00000000-0000-4000-8000-000000000002",
};

function fixture(unsafe = false) {
  const query = vi.fn<(sql: string, values?: unknown[]) => Promise<{ rows: { unsafe: boolean }[] }>>()
    .mockImplementation((sql) => Promise.resolve({ rows: sql.includes("rolsuper") ? [{ unsafe }] : [] }));
  const release = vi.fn();
  const client = { query, release } as unknown as pg.PoolClient;
  const connect = vi.fn().mockResolvedValue(client);
  const database = new PostgresDatabase({ connect });
  return { database, query, release, connect };
}

describe("tenant transactions", () => {
  it("sets transaction-local identity before work and commits before returning", async () => {
    const db = fixture();
    const result = await db.database.withTenant(identity, async (client) => {
      await client.query("SELECT protected_data");
      return 42;
    });
    expect(result).toBe(42);
    expect(db.query.mock.calls.map(([sql]) => sql)).toEqual([
      "BEGIN", "SET LOCAL statement_timeout = '10s'",
      "SELECT rolsuper OR rolbypassrls AS unsafe FROM pg_roles WHERE rolname = current_user",
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.actor_id', $2, true)",
      "SELECT protected_data", "COMMIT",
    ]);
    expect(db.query.mock.calls[3]?.[1]).toEqual([identity.tenantId, identity.actorId]);
    expect(db.release).toHaveBeenCalledOnce();
  });

  it("rolls back failed operations and preserves the original error", async () => {
    const db = fixture();
    const failure = new Error("operation failed");
    await expect(db.database.withTenant(identity, () => Promise.reject(failure))).rejects.toBe(failure);
    expect(db.query.mock.calls.at(-1)?.[0]).toBe("ROLLBACK");
    expect(db.release).toHaveBeenCalledWith(undefined);
  });

  it("discards a connection if rollback fails", async () => {
    const db = fixture();
    db.query.mockRejectedValue(new Error("connection lost"));
    await expect(db.database.withTenant(identity, () => Promise.resolve())).rejects.toThrow("connection lost");
    expect(db.release).toHaveBeenCalledWith(expect.any(Error));
  });

  it("rejects roles that bypass RLS before running application SQL", async () => {
    const db = fixture(true);
    const operation = vi.fn();
    await expect(db.database.withTenant(identity, operation)).rejects.toThrow("must enforce row level security");
    expect(operation).not.toHaveBeenCalled();
    expect(db.query.mock.calls.at(-1)?.[0]).toBe("ROLLBACK");
    expect(db.release).toHaveBeenCalledOnce();
  });

  it("rejects malformed trusted identity before opening a connection", async () => {
    const db = fixture();
    await expect(db.database.withTenant({ ...identity, tenantId: "invalid" }, () => Promise.resolve())).rejects.toThrow("Invalid trusted");
    expect(db.connect).not.toHaveBeenCalled();
  });

  it("resets identity for every transaction even on a reused connection", async () => {
    const db = fixture();
    await db.database.withTenant(identity, () => Promise.resolve());
    const other = { ...identity, tenantId: "00000000-0000-4000-8000-000000000003" };
    await db.database.withTenant(other, () => Promise.resolve());
    expect(db.query.mock.calls.filter(([sql]) => sql.includes("set_config")).map(([, values]) => values)).toEqual([
      [identity.tenantId, identity.actorId], [other.tenantId, other.actorId],
    ]);
  });
});
