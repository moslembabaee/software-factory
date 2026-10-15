/**
 * Factory domain primitive: Execution.
 *
 * An execution is a concrete run of a Work item by an actor, carrying the
 * lifecycle state, attempt number, budget accounting, and optional links to
 * the worker, sandbox, and external run that performed it.
 *
 * State guidance (docs/06): created -> running -> terminal | unknown.
 * Execution and AgentRun lifecycles are separate (SF-ADR-007).
 */
export type ExecutionState = "queued" | "running" | "awaiting_approval" | "verifying" | "needs_reconciliation" | "cancelling" | "completed" | "failed" | "cancelled" | "budget_exhausted";
export interface Execution {
    readonly id: string;
    readonly tenantId: string;
    readonly workId: string;
    readonly actorId: string;
    readonly parentExecutionId?: string;
    readonly workerId?: string;
    readonly state: ExecutionState;
    readonly attemptNo: number;
    readonly budgetCapUsd: number;
    readonly reservedUsd: number;
    readonly spentUsd: number;
    readonly sandboxRef?: string;
    readonly externalRunRef?: string;
    readonly startedAt?: string;
    readonly endedAt?: string;
    readonly metadata?: Readonly<Record<string, unknown>>;
    readonly createdAt: string;
}
