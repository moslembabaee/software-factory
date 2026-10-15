/**
 * Factory domain primitive: Work.
 *
 * Work is a unit of intent to be fulfilled by the factory. It is owned by a
 * tenant and scoped to a project, references the actor that created it, and
 * tracks an explicit lifecycle state with optimistic-concurrency versioning.
 *
 * State guidance (docs/06): open -> active -> terminal. Terminal outcomes
 * (completed | cancelled | failed) are distinct; completed requires accepted
 * verification and acceptance evidence.
 */
export type WorkState =
  | "open"
  | "active"
  | "blocked"
  | "waiting_approval"
  | "paused"
  | "completed"
  | "cancelled"
  | "failed";

export interface Work {
  readonly id: string;
  readonly tenantId: string;
  readonly projectId: string;
  readonly createdBy: string;
  readonly objective: string;
  readonly state: WorkState;
  readonly version: number;
  readonly createdAt: string;
}