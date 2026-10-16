import {
  ExecutionSchema,
  SandboxResultSchema,
} from "@software-factory/factory-core";
import type {
  Execution,
  ExecutionSandbox,
  QueueIdentity,
  QueueItem,
  SandboxProgram,
  SandboxResult,
  WorkQueue,
} from "@software-factory/factory-core";
import { SandboxError } from "./sandbox.js";

/** Executes an already leased dispatch; durable lifecycle authority stays in Core/SQL. */
export class ExecutionWorker {
  constructor(
    private readonly queue: WorkQueue,
    private readonly sandbox: ExecutionSandbox,
  ) {}

  async execute(
    identity: QueueIdentity,
    claim: QueueItem,
    execution: Execution,
    program: SandboxProgram,
    signal?: AbortSignal,
  ): Promise<SandboxResult> {
    const current = ExecutionSchema.parse(execution);
    const remaining = Date.parse(claim.expiresAt ?? "") - Date.now();
    if (
      claim.status !== "leased" ||
      !claim.workerId ||
      !Number.isSafeInteger(claim.fence) ||
      claim.fence < 1 ||
      identity.tenantId !== claim.tenantId ||
      current.tenantId !== claim.tenantId ||
      current.id !== claim.executionId ||
      current.workId !== claim.workId ||
      current.version !== claim.executionVersion ||
      current.state !== "running" ||
      (current.workerId !== undefined && current.workerId !== claim.workerId) ||
      !Number.isFinite(remaining) ||
      remaining < 1 ||
      signal?.aborted
    )
      throw new SandboxError(
        "Execution does not match an active tenant dispatch",
      );
    // Stop on local lease expiry as well as caller cancellation. The database's
    // fencing/clock check at ack remains authoritative if clocks differ.
    const controller = new AbortController();
    const abort = () => {
      controller.abort();
    };
    signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(abort, remaining);
    try {
      const result = await this.sandbox.execute(
        current,
        program,
        controller.signal,
      );
      if (controller.signal.aborted || result.status === "cancelled") {
        throw new SandboxError(
          "Execution cancelled or lease expired; do not acknowledge",
          result.sandboxRef,
        );
      }
      if (
        !SandboxResultSchema.safeParse(result).success ||
        result.executionId !== current.id ||
        result.tenantId !== identity.tenantId
      ) {
        throw new SandboxError("Sandbox result does not match this dispatch");
      }
      await this.queue.ack(identity, {
        id: claim.id,
        workerId: claim.workerId,
        fence: claim.fence,
        expectedVersion: current.version,
        // A successful process is a proposal to verify, never Execution.completed.
        outcome: result.status === "succeeded" ? "verifying" : "failed",
      });
      return result;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    }
  }
}
