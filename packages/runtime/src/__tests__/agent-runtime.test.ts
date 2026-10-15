import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  Event,
  Execution,
  QueueItem,
} from "@software-factory/factory-core";
import {
  PostgresAgentContext,
  PostgresExecutionHistory,
  PostgresWorkQueue,
} from "@software-factory/storage";
import type {
  AgentCheckpoint,
  AgentContext,
  TenantDatabase,
} from "@software-factory/storage";
import { createAgentRuntime } from "../agent-runtime.js";
import type { AgentRuntimeOptions } from "../agent-runtime.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function fixture(restored = true) {
  const identity = { tenantId: randomUUID(), actorId: randomUUID() };
  const parentId = randomUUID();
  const execution: Execution = {
    id: randomUUID(),
    tenantId: identity.tenantId,
    workId: randomUUID(),
    parentExecutionId: parentId,
    state: "running",
    version: 1,
    budgetCapUsd: 10,
    spentUsd: 0,
    reservedUsd: 0,
    createdAt: new Date().toISOString(),
  };
  const claim: QueueItem = {
    id: randomUUID(),
    executionId: execution.id,
    workId: execution.workId,
    tenantId: identity.tenantId,
    status: "leased",
    workerId: "worker",
    fence: 1,
    executionVersion: 1,
    priority: 0,
    createdAt: execution.createdAt,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  };
  const context: AgentContext = {
    schemaVersion: 1,
    baseSha: "a".repeat(40),
    policyVersion: "p1",
    modelProfile: "coding",
    messages: [{ role: "user", content: "Fix login" }],
    summary: null,
    metadata: {},
  };
  const checkpoint: AgentCheckpoint = {
    id: randomUUID(),
    tenantId: identity.tenantId,
    workId: execution.workId,
    executionId: parentId,
    sequence: 3,
    step: 7,
    workerId: "lost-worker",
    fence: 1,
    context,
    createdAt: execution.createdAt,
  };
  vi.spyOn(PostgresExecutionHistory.prototype, "get")
    .mockResolvedValueOnce({ ...execution, state: "queued", version: 0 })
    .mockResolvedValue(execution);
  vi.spyOn(PostgresWorkQueue.prototype, "get").mockResolvedValue(claim);
  vi.spyOn(PostgresWorkQueue.prototype, "dequeue").mockResolvedValue(claim);
  const ack = vi
    .spyOn(PostgresWorkQueue.prototype, "ack")
    .mockResolvedValue({ ...claim, status: "acknowledged" });
  vi.spyOn(PostgresAgentContext.prototype, "restore").mockResolvedValue(
    restored ? checkpoint : null,
  );
  const save = vi
    .spyOn(PostgresAgentContext.prototype, "save")
    .mockImplementation((_identity, input) =>
      Promise.resolve({
        ...checkpoint,
        id: input.id,
        executionId: execution.id,
        sequence: input.expectedSequence + 1,
        step: input.step,
        context: input.context,
        workerId: input.workerId,
      }),
    );
  const runAgent = vi
    .fn<AgentRuntimeOptions["runAgent"]>()
    .mockImplementation((current) =>
      Promise.resolve({
        executionId: current.id,
        tenantId: current.tenantId,
        sandboxRef: "docker:test",
        status: "succeeded",
        exitCode: 0,
        stdout: "",
        stderr: "",
        durationMs: 1,
        cleanupConfirmed: true,
      }),
    );
  const contextBinding = vi.fn().mockResolvedValue(context);
  const runtime = createAgentRuntime({
    identity,
    database: { withTenant: vi.fn() } as TenantDatabase,
    workerId: "worker",
    resolveProgram: () =>
      Promise.resolve({ code: "proposal", trust: "trusted" }),
    contextBinding,
    runAgent,
  });
  const event: Event = {
    id: randomUUID(),
    tenantId: identity.tenantId,
    executionId: execution.id,
    type: "queue.enqueued",
    sequence: 1,
    occurredAt: execution.createdAt,
    payload: {},
  };
  return {
    identity,
    execution,
    checkpoint,
    context,
    runtime,
    event,
    runAgent,
    contextBinding,
    save,
    ack,
  };
}

describe("checkpointed agent runtime", () => {
  it("restores a lost attempt and saves subsequent observations with the new dispatch's fencing", async () => {
    const f = fixture();
    f.runAgent.mockImplementationOnce(async (execution, _program, session) => {
      expect(session.checkpoint).toEqual(f.checkpoint);
      const id = randomUUID();
      await session.save(8, f.context, id);
      await session.save(8, f.context, id); // safe retry of a response lost after commit
      await session.save(9, f.context);
      return {
        executionId: execution.id,
        tenantId: execution.tenantId,
        sandboxRef: "docker:new",
        status: "succeeded",
        exitCode: 0,
        stdout: "",
        stderr: "",
        durationMs: 1,
        cleanupConfirmed: true,
      };
    });
    await f.runtime.bus.publish(f.event);
    expect(f.contextBinding).toHaveBeenCalledWith(f.execution);
    expect(
      f.save.mock.calls.map(([, input]) => input.expectedSequence),
    ).toEqual([0, 0, 1]);
    expect(f.save.mock.calls[0]?.[1]).toMatchObject({
      executionId: f.execution.id,
      expectedVersion: 1,
      workerId: "worker",
      fence: 1,
    });
    expect(f.ack).toHaveBeenCalledWith(
      f.identity,
      expect.objectContaining({ outcome: "verifying" }),
    );
  });

  it("starts a fresh task without a checkpoint", async () => {
    const f = fixture(false);
    await f.runtime.bus.publish(f.event);
    expect(f.runAgent.mock.calls[0]?.[2].checkpoint).toBeNull();
    expect(f.ack).toHaveBeenCalledOnce();
  });

  it("leaves a crashing agent unacknowledged for lease expiry and recovery", async () => {
    const f = fixture();
    f.runAgent.mockImplementation(async (_execution, _program, session) => {
      await session.save(8, f.context);
      throw new Error("worker crashed");
    });
    await expect(f.runtime.bus.publish(f.event)).rejects.toThrow(
      "worker crashed",
    );
    expect(f.save).toHaveBeenCalledOnce();
    expect(f.ack).not.toHaveBeenCalled();
  });

  it("blocks changed policy and regressing steps", async () => {
    const f = fixture();
    f.runAgent.mockImplementation(async (_execution, _program, session) => {
      await expect(session.save(7, f.context)).rejects.toThrow(
        "step must advance",
      );
      await session.save(8, {
        ...f.context,
        policyVersion: "untrusted-policy",
      });
      throw new Error("unreachable");
    });
    await expect(f.runtime.bus.publish(f.event)).rejects.toThrow(
      "trusted configuration",
    );
    expect(f.save).not.toHaveBeenCalled();
    expect(f.ack).not.toHaveBeenCalled();
  });

  it("does not start the agent if checkpoint binding validation fails", async () => {
    const f = fixture();
    vi.spyOn(PostgresAgentContext.prototype, "restore").mockRejectedValue(
      new Error("policy changed"),
    );
    await expect(f.runtime.bus.publish(f.event)).rejects.toThrow(
      "policy changed",
    );
    expect(f.runAgent).not.toHaveBeenCalled();
    expect(f.ack).not.toHaveBeenCalled();
  });

  it("does not run after dispatch ownership changes", async () => {
    const f = fixture();
    vi.spyOn(PostgresWorkQueue.prototype, "get").mockResolvedValue(null);
    await expect(f.runtime.bus.publish(f.event)).rejects.toThrow(
      "ownership has changed",
    );
    expect(f.runAgent).not.toHaveBeenCalled();
  });

  it("stops checkpoint writes and acknowledgements when the dispatch times out", async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.runAgent.mockImplementation(
      async (execution, _program, session, signal) => {
        if (!signal) throw new Error("Missing abort signal");
        await new Promise<void>((resolve) => {
          signal.addEventListener("abort", () => { resolve(); }, { once: true });
        });
        await expect(session.save(8, f.context)).rejects.toThrow("cancelled");
        return {
          executionId: execution.id,
          tenantId: execution.tenantId,
          sandboxRef: "docker:expired",
          status: "cancelled",
          exitCode: null,
          stdout: "",
          stderr: "",
          durationMs: 60_000,
          cleanupConfirmed: true,
        };
      },
    );
    const failure = expect(f.runtime.bus.publish(f.event)).rejects.toThrow(
      "cancelled or lease expired",
    );
    await vi.advanceTimersByTimeAsync(60_001);
    await failure;
    expect(f.save).not.toHaveBeenCalled();
    expect(f.ack).not.toHaveBeenCalled();
  });
});
