import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { EventBus } from "@software-factory/events";
import type {
  Event,
  Execution,
  QueueItem,
  SandboxResult,
  WorkQueue,
} from "@software-factory/factory-core";
import { ExecutionWorker } from "../execution-worker.js";
import { QueueSandboxDispatcher } from "../queue-dispatcher.js";

function fixture() {
  const identity = { tenantId: randomUUID(), actorId: randomUUID() };
  let execution: Execution = {
    id: randomUUID(),
    tenantId: identity.tenantId,
    workId: randomUUID(),
    parentExecutionId: null,
    state: "queued",
    version: 0,
    budgetCapUsd: 10,
    reservedUsd: 0,
    spentUsd: 0,
    createdAt: new Date().toISOString(),
  };
  const claim: QueueItem = {
    id: randomUUID(),
    tenantId: identity.tenantId,
    workId: execution.workId,
    executionId: execution.id,
    priority: 0,
    status: "leased",
    workerId: "worker",
    fence: 1,
    executionVersion: 1,
    createdAt: execution.createdAt,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  };
  const queue = {
    get: vi.fn<WorkQueue["get"]>().mockResolvedValue(null),
    enqueue: vi
      .fn<WorkQueue["enqueue"]>()
      .mockResolvedValue({ ...claim, status: "queued" }),
    dequeue: vi.fn<WorkQueue["dequeue"]>().mockImplementation(() => {
      if (execution.state !== "queued") return Promise.resolve(null);
      execution = { ...execution, state: "running", version: 1 };
      return Promise.resolve(claim);
    }),
    ack: vi.fn<WorkQueue["ack"]>().mockImplementation((_identity, input) => {
      execution = { ...execution, state: input.outcome, version: 2 };
      return Promise.resolve({ ...claim, status: "acknowledged" });
    }),
    timeout: vi.fn<WorkQueue["timeout"]>().mockResolvedValue([]),
  } satisfies WorkQueue;
  const result: SandboxResult = {
    tenantId: identity.tenantId,
    executionId: execution.id,
    sandboxRef: "docker:test",
    status: "succeeded",
    exitCode: 0,
    stdout: "ok",
    stderr: "",
    durationMs: 1,
    cleanupConfirmed: true,
  };
  const sandbox = {
    execute: vi.fn<() => Promise<SandboxResult>>().mockResolvedValue(result),
  };
  const resolveProgram = vi.fn(() =>
    Promise.resolve({
      code: "console.log('ok')",
      trust: "trusted" as const,
    }),
  );
  const bus = new EventBus();
  const loadExecution = vi.fn(() => Promise.resolve(execution));
  const dispatcher = new QueueSandboxDispatcher(
    identity,
    queue,
    new ExecutionWorker(queue, sandbox),
    {
      workerId: "worker",
      leaseMs: 60_000,
      loadExecution,
      resolveProgram,
    },
  );
  const stop = dispatcher.connect(bus);
  const event = (type: Event["type"]): Event => ({
    id: randomUUID(),
    tenantId: identity.tenantId,
    executionId: execution.id,
    sequence: 0,
    type,
    payload: {},
    occurredAt: execution.createdAt,
  });
  return {
    identity,
    queue,
    claim,
    sandbox,
    result,
    resolveProgram,
    bus,
    event,
    stop,
    loadExecution,
    getExecution: () => execution,
  };
}

describe("queue event sandbox dispatch", () => {
  it("wires creation to enqueue, and queue delivery through sandbox to verification", async () => {
    const f = fixture();
    await f.bus.publish(f.event("execution.created"));
    expect(f.queue.enqueue).toHaveBeenCalledWith(f.identity, {
      executionId: f.getExecution().id,
      expectedVersion: 0,
    });
    expect(f.sandbox.execute).not.toHaveBeenCalled();
    await f.bus.publish(f.event("queue.enqueued"));
    expect(f.queue.dequeue).toHaveBeenCalledWith(f.identity, {
      executionId: f.getExecution().id,
      workerId: "worker",
      leaseMs: 60_000,
    });
    expect(f.sandbox.execute).toHaveBeenCalledOnce();
    expect(f.queue.ack).toHaveBeenCalledWith(f.identity, {
      id: f.claim.id,
      workerId: "worker",
      fence: 1,
      expectedVersion: 1,
      outcome: "verifying",
    });
    expect(f.getExecution().state).toBe("verifying");
  });

  it("does not execute a repeated or concurrently delivered queue event twice", async () => {
    const f = fixture();
    const event = f.event("queue.enqueued");
    await Promise.all([f.bus.publish(event), f.bus.publish(event)]);
    await f.bus.publish(event);
    expect(f.sandbox.execute).toHaveBeenCalledOnce();
    expect(f.queue.ack).toHaveBeenCalledOnce();
  });

  it.each(["failed", "timed_out", "out_of_memory", "output_limit"] as const)(
    "records sandbox %s as execution failure",
    async (status) => {
      const f = fixture();
      f.sandbox.execute.mockResolvedValue({ ...f.result, status, exitCode: 1 });
      await f.bus.publish(f.event("queue.enqueued"));
      expect(f.getExecution().state).toBe("failed");
    },
  );

  it("leaves cleanup uncertainty for timeout reconciliation without acknowledgement or replay", async () => {
    const f = fixture();
    f.sandbox.execute.mockRejectedValue(new Error("cleanup uncertain"));
    const event = f.event("queue.enqueued");
    await expect(f.bus.publish(event)).rejects.toThrow("cleanup uncertain");
    await f.bus.publish(event);
    expect(f.queue.ack).not.toHaveBeenCalled();
    expect(f.sandbox.execute).toHaveBeenCalledOnce();
  });

  it("keeps transient program lookup failures retryable before leasing", async () => {
    const f = fixture();
    f.resolveProgram.mockRejectedValueOnce(new Error("source unavailable"));
    const event = f.event("queue.enqueued");
    await expect(f.bus.publish(event)).rejects.toThrow("source unavailable");
    expect(f.queue.dequeue).not.toHaveBeenCalled();
    await f.bus.publish(event);
    expect(f.sandbox.execute).toHaveBeenCalledOnce();
  });

  it("ignores an unavailable claim and rejects cross-tenant events before reading", async () => {
    const f = fixture();
    vi.mocked(f.queue.dequeue).mockResolvedValue(null);
    await f.bus.publish(f.event("queue.enqueued"));
    expect(f.sandbox.execute).not.toHaveBeenCalled();
    f.loadExecution.mockClear();
    await expect(
      f.bus.publish({ ...f.event("queue.enqueued"), tenantId: randomUUID() }),
    ).rejects.toThrow("another tenant");
    expect(f.loadExecution).not.toHaveBeenCalled();
    f.stop();
    await f.bus.publish(f.event("queue.enqueued"));
    expect(f.loadExecution).not.toHaveBeenCalled();
  });

  it("keeps wakeups pending when SKIP LOCKED skips an eligible dispatch", async () => {
    const f = fixture();
    vi.mocked(f.queue.dequeue).mockResolvedValue(null);
    vi.mocked(f.queue.get).mockResolvedValue({ ...f.claim, status: "queued" });
    await expect(f.bus.publish(f.event("queue.enqueued"))).rejects.toThrow(
      "retry event delivery",
    );
    expect(f.sandbox.execute).not.toHaveBeenCalled();
  });

  it("rejects foreign sandbox results and cancelled execution without acknowledgement", async () => {
    const f = fixture();
    f.sandbox.execute.mockResolvedValue({
      ...f.result,
      tenantId: randomUUID(),
    });
    await expect(f.bus.publish(f.event("queue.enqueued"))).rejects.toThrow(
      "does not match",
    );
    expect(f.queue.ack).not.toHaveBeenCalled();
    const cancelled = fixture();
    cancelled.loadExecution.mockResolvedValue({
      ...cancelled.getExecution(),
      state: "cancelling",
    });
    await cancelled.bus.publish(cancelled.event("queue.enqueued"));
    expect(cancelled.queue.dequeue).not.toHaveBeenCalled();
  });
});
