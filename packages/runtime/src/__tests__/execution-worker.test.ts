import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type {
  Execution,
  ExecutionSandbox,
  QueueItem,
  SandboxResult,
  WorkQueue,
} from "@software-factory/factory-core";
import { DockerSandbox, SandboxCleanupError } from "@software-factory/sandbox";
import type {
  CommandRunner,
  CommandResult,
} from "@software-factory/sandbox/command";
import { ExecutionWorker } from "../execution-worker.js";

function fixture() {
  const identity = { tenantId: randomUUID(), actorId: randomUUID() };
  const execution: Execution = {
    id: randomUUID(),
    tenantId: identity.tenantId,
    workId: randomUUID(),
    parentExecutionId: null,
    state: "running",
    version: 1,
    workerId: "worker",
    budgetCapUsd: 1,
    reservedUsd: 0,
    spentUsd: 0,
    createdAt: new Date().toISOString(),
  };
  const claim: QueueItem = {
    id: randomUUID(),
    tenantId: identity.tenantId,
    workId: execution.workId,
    executionId: execution.id,
    status: "leased",
    priority: 0,
    workerId: "worker",
    fence: 2,
    executionVersion: 1,
    createdAt: execution.createdAt,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  };
  const queue = {
    ack: vi
      .fn<WorkQueue["ack"]>()
      .mockResolvedValue({ ...claim, status: "acknowledged" }),
    get: vi.fn<WorkQueue["get"]>(),
    enqueue: vi.fn<WorkQueue["enqueue"]>(),
    dequeue: vi.fn<WorkQueue["dequeue"]>(),
    timeout: vi.fn<WorkQueue["timeout"]>(),
  };
  const result: SandboxResult = {
    tenantId: identity.tenantId,
    executionId: execution.id,
    sandboxRef: "docker:test",
    status: "succeeded",
    exitCode: 0,
    stdout: "",
    stderr: "",
    durationMs: 1,
    cleanupConfirmed: true,
  };
  const sandbox = {
    execute: vi.fn<ExecutionSandbox["execute"]>().mockResolvedValue(result),
  };
  return {
    identity,
    execution,
    claim,
    queue,
    sandbox,
    result,
    worker: new ExecutionWorker(queue, sandbox),
  };
}
const program = { code: "console.log('ok')", trust: "trusted" as const };

describe("Execution sandbox worker", () => {
  it.each([
    "succeeded",
    "failed",
    "out_of_memory",
    "timed_out",
    "output_limit",
  ] as const)(
    "wires the Docker adapter's %s result to a fenced acknowledgement after removal",
    async (status) => {
      const f = fixture();
      let removed = false;
      const command = vi
        .fn<CommandRunner>()
        .mockImplementation((_bin, args) => {
          const result = {
            stdout: "",
            stderr: "",
            exitCode: 0,
            stopReason: null as CommandResult["stopReason"],
          };
          if (args[0] === "image") result.stdout = "{}";
          if (args[0] === "inspect")
            result.stdout = JSON.stringify({
              Running: false,
              Status: "exited",
              Error: "",
              ExitCode: status === "succeeded" ? 0 : 1,
              OOMKilled: status === "out_of_memory",
            });
          if (
            args[0] === "start" &&
            (status === "timed_out" || status === "output_limit")
          )
            result.stopReason = status;
          if (args[0] === "rm") removed = true;
          return Promise.resolve(result);
        });
      const sandbox = new DockerSandbox(
        { image: `node@sha256:${"a".repeat(64)}` },
        command,
      );
      f.queue.ack.mockImplementation(() => {
        expect(removed).toBe(true);
        return Promise.resolve({ ...f.claim, status: "acknowledged" });
      });
      const result = await new ExecutionWorker(f.queue, sandbox).execute(
        f.identity,
        f.claim,
        f.execution,
        program,
      );
      expect(result.status).toBe(status);
      expect(f.queue.ack).toHaveBeenCalledWith(f.identity, {
        id: f.claim.id,
        workerId: "worker",
        fence: 2,
        expectedVersion: 1,
        outcome: status === "succeeded" ? "verifying" : "failed",
      });
    },
  );

  it.each([
    { status: "queued" },
    { fence: 0 },
    { fence: 1.5 },
    { workerId: null },
    { executionId: randomUUID() },
    { workId: randomUUID() },
    { tenantId: randomUUID() },
    { executionVersion: 2 },
    { expiresAt: "invalid" },
    { expiresAt: new Date(0).toISOString() },
  ])(
    "rejects an invalid dispatch before executing code: %j",
    async (invalid) => {
      const f = fixture();
      await expect(
        f.worker.execute(
          f.identity,
          { ...f.claim, ...invalid } as QueueItem,
          f.execution,
          program,
        ),
      ).rejects.toThrow("active tenant dispatch");
      expect(f.sandbox.execute).not.toHaveBeenCalled();
      expect(f.queue.ack).not.toHaveBeenCalled();
    },
  );

  it.each([
    { executionId: randomUUID() },
    { tenantId: randomUUID() },
    { cleanupConfirmed: false },
    { status: "unknown" },
    { durationMs: -1 },
  ])("rejects a mismatched or invalid sandbox result: %j", async (invalid) => {
    const f = fixture();
    f.sandbox.execute.mockResolvedValue({
      ...f.result,
      ...invalid,
    } as SandboxResult);
    await expect(
      f.worker.execute(f.identity, f.claim, f.execution, program),
    ).rejects.toThrow("does not match");
    expect(f.queue.ack).not.toHaveBeenCalled();
  });

  it("leaves cleanup failures for reconciliation", async () => {
    const f = fixture();
    f.sandbox.execute.mockRejectedValue(
      new SandboxCleanupError("cleanup uncertain", "docker:retained"),
    );
    await expect(
      f.worker.execute(f.identity, f.claim, f.execution, program),
    ).rejects.toBeInstanceOf(SandboxCleanupError);
    expect(f.queue.ack).not.toHaveBeenCalled();
  });

  it.each(["lease", "caller"])(
    "propagates %s cancellation and never acknowledges even a successful late result",
    async (source) => {
      const f = fixture();
      const controller = new AbortController();
      const claim =
        source === "lease"
          ? { ...f.claim, expiresAt: new Date(Date.now() + 100).toISOString() }
          : f.claim;
      f.sandbox.execute.mockImplementation(
        (_execution, _program, signal) =>
          new Promise((resolve) => {
            signal?.addEventListener(
              "abort",
              () => {
                resolve(f.result);
              },
              { once: true },
            );
          }),
      );
      const task = f.worker.execute(
        f.identity,
        claim,
        f.execution,
        program,
        controller.signal,
      );
      if (source === "caller") controller.abort();
      await expect(task).rejects.toThrow("cancelled or lease expired");
      expect(f.queue.ack).not.toHaveBeenCalled();
    },
  );

  it("rejects an already cancelled dispatch before invoking the sandbox", async () => {
    const f = fixture();
    const controller = new AbortController();
    controller.abort();
    await expect(
      f.worker.execute(
        f.identity,
        f.claim,
        f.execution,
        program,
        controller.signal,
      ),
    ).rejects.toThrow("active tenant dispatch");
    expect(f.sandbox.execute).not.toHaveBeenCalled();
  });
});
