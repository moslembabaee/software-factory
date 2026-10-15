/**
 * Factory domain primitive: Event.
 *
 * An event is an append-only record of something that happened in the
 * factory, correlated to an execution. The event log is the audit and
 * integration record; it is not a fully replayable event-sourced system
 * (docs/06: authoritative state is transactional relational state).
 */
export interface Event<TType extends string = string, TPayload = unknown> {
  readonly id: string;
  readonly tenantId: string;
  readonly executionId?: string;
  /** Per-execution sequence number (UNIQUE(tenant_id, execution_id, sequence)). */
  readonly sequence: number;
  readonly type: TType;
  readonly source: string;
  readonly subjectId?: string;
  readonly occurredAt: string;
  readonly recordedAt: string;
  readonly correlationId?: string;
  readonly causationId?: string;
  readonly payload: TPayload;
}