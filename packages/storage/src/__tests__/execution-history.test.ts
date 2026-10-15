import { randomUUID } from "node:crypto";
import type pg from "pg";
import { describe, expect, it, vi } from "vitest";
import type { TenantDatabase } from "../database.js";
import {
  ExecutionConflictError,
  PostgresExecutionHistory,
} from "../execution-history.js";

const identity = { tenantId: randomUUID(), actorId: randomUUID() };
const decision = {
  executionId: randomUUID(),
  expectedVersion: 2,
  causeEventId: randomUUID(),
  evidenceArtifactId: randomUUID(),
  outcome: "completed" as const,
};
function fixture(state = "verifying", version = "2") {
  const query = vi
    .fn<
      (
        sql: string,
        values?: unknown[],
      ) => Promise<{ rows: Record<string, unknown>[] }>
    >()
    .mockResolvedValue({ rows: [] })
    .mockResolvedValueOnce({ rows: [{ state, version }] });
  const database: TenantDatabase = {
    withTenant: async (_identity, operation) =>
      operation({ query } as unknown as pg.PoolClient),
  };
  return { query, history: new PostgresExecutionHistory(database) };
}

describe("verification lifecycle authority", () => {
  it.each(["running", "queued", "completed", "failed"])(
    "rejects completion from %s",
    async (state) => {
      const f = fixture(state);
      await expect(
        f.history.finishVerification(identity, decision),
      ).rejects.toBeInstanceOf(ExecutionConflictError);
      expect(f.query).toHaveBeenCalledOnce();
    },
  );

  it("rejects stale versions and missing verification evidence", async () => {
    await expect(
      fixture("verifying", "3").history.finishVerification(identity, decision),
    ).rejects.toThrow("version");
    const f = fixture();
    await expect(
      f.history.finishVerification(identity, decision),
    ).rejects.toThrow("evidence");
    expect(f.query.mock.calls.some(([sql]) => sql.startsWith("UPDATE"))).toBe(
      false,
    );
  });

  it.each([
    { decision: "pending", valid: false },
    { decision: "denied", valid: false },
    { decision: "approved", valid: false },
  ])("blocks incomplete, denied or expired approvals", async (approval) => {
    const f = fixture();
    f.query.mockResolvedValueOnce({
      rows: [{ id: decision.evidenceArtifactId }],
    });
    f.query.mockResolvedValueOnce({ rows: [approval] });
    await expect(
      f.history.finishVerification(identity, decision),
    ).rejects.toThrow("approvals");
    expect(f.query.mock.calls.some(([sql]) => sql.startsWith("UPDATE"))).toBe(
      false,
    );
  });

  it.each(["completed", "failed"] as const)(
    "records a verifier's %s decision with causation and outbox",
    async (outcome) => {
      const f = fixture();
      f.query.mockResolvedValueOnce({
        rows: [{ id: decision.evidenceArtifactId }],
      });
      if (outcome === "completed")
        f.query.mockResolvedValueOnce({
          rows: [{ decision: "approved", valid: true }],
        });
      f.query.mockResolvedValueOnce({ rows: [] }); // state change
      f.query.mockResolvedValueOnce({ rows: [{ id: randomUUID() }] }); // event
      await f.history.finishVerification(identity, { ...decision, outcome });
      const event = f.query.mock.calls.find(([sql]) =>
        sql.includes("INSERT INTO events"),
      );
      expect(event?.[1]?.[2]).toBe(`execution.${outcome}`);
      expect(JSON.parse(String(event?.[1]?.[3]))).toMatchObject({
        actor_id: identity.actorId,
        cause_event_id: decision.causeEventId,
        evidence_artifact_id: decision.evidenceArtifactId,
      });
      expect(f.query.mock.calls.at(-1)?.[0]).toContain("INSERT INTO outbox");
    },
  );
});
