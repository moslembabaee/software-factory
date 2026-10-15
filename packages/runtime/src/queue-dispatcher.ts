import { ExecutionSchema } from "@software-factory/factory-core";
import type {
  Event,
  Execution,
  QueueIdentity,
  SandboxProgram,
  WorkQueue,
} from "@software-factory/factory-core";
import type { EventBus } from "@software-factory/events";
import { ExecutionWorker } from "./execution-worker.js";

export interface QueueDispatcherOptions {
  readonly workerId: string;
  readonly leaseMs: number;
  /** Tenant-scoped storage read; never reconstruct mutable state from a delivery. */
  readonly loadExecution: (
    identity: QueueIdentity,
    id: string,
  ) => Promise<Execution | null>;
  /** Trusted worker configuration resolves source and trust classification. */
  readonly resolveProgram: (execution: Execution) => Promise<SandboxProgram>;
}

/** Connect one trusted tenant's durable queue events to its fenced sandbox worker. */
export class QueueSandboxDispatcher {
  constructor(
    private readonly identity: QueueIdentity,
    private readonly queue: WorkQueue,
    private readonly worker: ExecutionWorker,
    private readonly options: QueueDispatcherOptions,
  ) {}

  connect(bus: EventBus): () => void {
    const unsubscribe = (
      ["execution.created", "execution.queued", "queue.enqueued"] as const
    ).map((type) => bus.subscribe(type, (event) => this.handle(event)));
    return () => {
      for (const stop of unsubscribe) stop();
    };
  }

  async handle(event: Event): Promise<void> {
    if (event.tenantId !== this.identity.tenantId)
      throw new Error("Dispatch event belongs to another tenant");
    if (
      !["execution.created", "execution.queued", "queue.enqueued"].includes(
        event.type,
      )
    )
      return;
    const loaded = await this.options.loadExecution(
      this.identity,
      event.executionId,
    );
    // Deleted, cancelled or already claimed executions cannot be replayed.
    if (!loaded) return;
    const execution = ExecutionSchema.parse(loaded);
    if (
      execution.tenantId !== this.identity.tenantId ||
      execution.id !== event.executionId
    ) {
      throw new Error("Execution does not match dispatch event");
    }
    if (execution.state !== "queued") return;
    if (event.type !== "queue.enqueued") {
      await this.queue.enqueue(this.identity, {
        executionId: execution.id,
        expectedVersion: execution.version,
      });
      return;
    }
    // Resolve before leasing: a transient source lookup failure is safely retryable.
    const program = await this.options.resolveProgram(execution);
    const claim = await this.queue.dequeue(this.identity, {
      workerId: this.options.workerId,
      leaseMs: this.options.leaseMs,
      executionId: execution.id,
    });
    if (!claim) {
      // SKIP LOCKED can mean contention rather than an empty queue. Publishing
      // that wakeup would strand an eligible dispatch after the lock is released.
      const pending = await this.queue.get(this.identity, execution.id);
      if (pending?.status === "queued")
        throw new Error("Dispatch is busy; retry event delivery");
      return;
    }
    const running = await this.options.loadExecution(
      this.identity,
      claim.executionId,
    );
    if (!running)
      throw new Error(
        "Claimed execution is unavailable; reconciliation required",
      );
    await this.worker.execute(this.identity, claim, running, program);
  }
}
