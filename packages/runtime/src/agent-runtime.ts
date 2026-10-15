import { randomUUID } from "node:crypto";
import type {
  Execution,
  QueueIdentity,
  SandboxProgram,
  SandboxResult,
} from "@software-factory/factory-core";
import {
  CheckpointConflictError,
  PostgresAgentContext,
  PostgresWorkQueue,
} from "@software-factory/storage";
import type {
  AgentCheckpoint,
  AgentContext,
  ContextBinding,
  TenantDatabase,
} from "@software-factory/storage";
import { createQueueRuntime } from "./queue-runtime.js";
import type { QueueDispatcherOptions } from "./queue-dispatcher.js";

export interface AgentContextSession {
  /** Includes the original attempt's checkpoint when this is a recovered run. */
  readonly checkpoint: AgentCheckpoint | null;
  /** Persist after each finalized observation, before starting the next step. */
  save(
    step: number,
    context: AgentContext,
    checkpointId?: string,
  ): Promise<AgentCheckpoint>;
}

export interface AgentRuntimeOptions {
  readonly identity: QueueIdentity;
  readonly database: TenantDatabase;
  readonly workerId: string;
  readonly leaseMs?: number;
  readonly resolveProgram: QueueDispatcherOptions["resolveProgram"];
  /** Trusted configuration revalidates the current repository/policy/model binding. */
  readonly contextBinding: (execution: Execution) => Promise<ContextBinding>;
  /** Agent output remains a proposal and must satisfy sandbox cleanup guarantees. */
  readonly runAgent: (
    execution: Execution,
    program: SandboxProgram,
    session: AgentContextSession,
    signal?: AbortSignal,
  ) => Promise<SandboxResult>;
}

/** Uses the existing queue's lease, timeout, outbox and independent verification path. */
export function createAgentRuntime(options: AgentRuntimeOptions) {
  const checkpoints = new PostgresAgentContext(options.database);
  const queue = new PostgresWorkQueue(options.database);
  const runtime = createQueueRuntime({
    ...options,
    sandbox: {
      async execute(execution, program, signal) {
        const claim = await queue.get(options.identity, execution.id);
        if (
          !claim ||
          claim.status !== "leased" ||
          claim.workerId !== options.workerId ||
          claim.executionVersion !== execution.version ||
          signal?.aborted
        )
          throw new CheckpointConflictError(
            "Agent dispatch ownership has changed",
          );
        const current = await options.contextBinding(execution);
        let saved = await checkpoints.restore(
          options.identity,
          execution.id,
          current,
        );
        if (signal?.aborted)
          throw new CheckpointConflictError("Agent dispatch was cancelled");
        const initial = saved;
        return options.runAgent(
          execution,
          program,
          {
            checkpoint: initial,
            async save(step, context, checkpointId = randomUUID()) {
              if (signal?.aborted)
                throw new CheckpointConflictError(
                  "Agent dispatch was cancelled",
                );
              if (
                context.baseSha !== current.baseSha ||
                context.policyVersion !== current.policyVersion ||
                context.modelProfile !== current.modelProfile
              )
                throw new CheckpointConflictError(
                  "Agent context no longer matches trusted configuration",
                );
              if (saved && step <= saved.step && checkpointId !== saved.id)
                throw new CheckpointConflictError(
                  "Agent step must advance beyond its restored checkpoint",
                );
              const own = saved?.executionId === execution.id ? saved : null;
              // An explicit ID can retry the most recent write without creating a new sequence.
              const expectedSequence = own
                ? own.sequence - (own.id === checkpointId ? 1 : 0)
                : 0;
              const result = await checkpoints.save(options.identity, {
                id: checkpointId,
                executionId: execution.id,
                expectedVersion: execution.version,
                workerId: options.workerId,
                fence: claim.fence,
                expectedSequence,
                step,
                context,
              });
              saved = result;
              return result;
            },
          },
          signal,
        );
      },
    },
  });
  return { ...runtime, checkpoints };
}
