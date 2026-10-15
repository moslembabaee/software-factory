import type { Execution, ExecutionState } from "./primitives/execution.js";
import type { Work } from "./primitives/work.js";

export type QueueStatus =
  "queued" | "leased" | "acknowledged" | "timed_out" | "cancelled";
export type QueueOutcome = Extract<
  ExecutionState,
  "verifying" | "awaiting_approval" | "failed"
>;

/**
 * A durable dispatch of one Execution. Higher priorities are served first, then
 * creation order. A dispatch moves queued -> leased -> acknowledged | timed_out;
 * stale or ineligible dispatches become cancelled. Terminal dispatches are retained.
 */
export interface QueueItem {
  readonly id: string;
  readonly tenantId: Work["tenantId"];
  readonly workId: Work["id"];
  readonly executionId: Execution["id"];
  readonly priority: number;
  readonly status: QueueStatus;
  readonly workerId: string | null;
  readonly fence: number;
  readonly executionVersion: Execution["version"];
  readonly createdAt: string;
  readonly expiresAt: string | null;
}

export interface EnqueueWork {
  readonly executionId: Execution["id"];
  readonly expectedVersion: Execution["version"];
  readonly priority?: number;
}

export interface DequeueWork {
  readonly workerId: string;
  readonly leaseMs: number;
}

export interface AcknowledgeWork {
  readonly id: QueueItem["id"];
  readonly workerId: string;
  readonly fence: number;
  readonly expectedVersion: Execution["version"];
  /** A dispatch acknowledgement hands the result to verification or approval. */
  readonly outcome: QueueOutcome;
}

export interface QueueIdentity {
  readonly tenantId: Work["tenantId"];
  readonly actorId: Work["createdBy"];
}

export interface WorkQueue {
  /** One dispatch per Execution; retries return that dispatch without reprioritizing. */
  enqueue(identity: QueueIdentity, input: EnqueueWork): Promise<QueueItem>;
  /** Atomically claims an eligible Execution and activates its Work; null if none. */
  dequeue(
    identity: QueueIdentity,
    input: DequeueWork,
  ): Promise<QueueItem | null>;
  /** Requires a live lease, matching worker/fence/version, and a running Execution. */
  ack(identity: QueueIdentity, input: AcknowledgeWork): Promise<QueueItem>;
  /**
   * Expires at most limit leases (default 100). Running Executions enter
   * needs_reconciliation; uncertain effects are never automatically replayed.
   */
  timeout(identity: QueueIdentity, limit?: number): Promise<QueueItem[]>;
}
