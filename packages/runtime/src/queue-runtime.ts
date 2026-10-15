import { EventBus } from "@software-factory/events";
import type {
  ExecutionSandbox,
  QueueIdentity,
} from "@software-factory/factory-core";
import {
  PostgresEventRelay,
  PostgresExecutionHistory,
  PostgresWorkQueue,
} from "@software-factory/storage";
import type { TenantDatabase } from "@software-factory/storage";
import { ExecutionWorker } from "./execution-worker.js";
import { QueueSandboxDispatcher } from "./queue-dispatcher.js";
import type { QueueDispatcherOptions } from "./queue-dispatcher.js";

/** One runtime per trusted tenant. Call runOnce from the worker's polling loop. */
export function createQueueRuntime(options: {
  readonly identity: QueueIdentity;
  readonly database: TenantDatabase;
  readonly sandbox: ExecutionSandbox;
  readonly workerId: string;
  readonly leaseMs?: number;
  readonly resolveProgram: QueueDispatcherOptions["resolveProgram"];
}) {
  const bus = new EventBus();
  const queue = new PostgresWorkQueue(options.database);
  const history = new PostgresExecutionHistory(options.database);
  const leaseMs = options.leaseMs ?? 60_000;
  const dispatcher = new QueueSandboxDispatcher(
    options.identity,
    queue,
    new ExecutionWorker(queue, options.sandbox),
    {
      workerId: options.workerId,
      leaseMs,
      loadExecution: (identity, id) => history.get(identity, id),
      resolveProgram: options.resolveProgram,
    },
  );
  dispatcher.connect(bus);
  const relay = new PostgresEventRelay(options.database, bus);
  return {
    bus,
    queue,
    history,
    async runOnce(limit = 100): Promise<number> {
      await queue.timeout(options.identity);
      return relay.flush(options.identity, { limit, leaseMs });
    },
  };
}
