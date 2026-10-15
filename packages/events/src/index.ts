import { EventSchema } from "@software-factory/factory-core";
import type {
  Event,
  EventType,
  ExecutionState,
} from "@software-factory/factory-core";

export type EventHandler = (event: Event) => Promise<void>;
export interface EventPublisher {
  publish(event: Event): Promise<void>;
}

/** Awaited, at-least-once delivery. Durability belongs to the PostgreSQL outbox. */
export class EventBus implements EventPublisher {
  private readonly handlers = new Map<EventType | "*", Set<EventHandler>>();

  subscribe(type: EventType | "*", handler: EventHandler): () => void {
    const handlers = this.handlers.get(type) ?? new Set<EventHandler>();
    handlers.add(handler);
    this.handlers.set(type, handlers);
    return () => {
      handlers.delete(handler);
    };
  }

  async publish(input: Event): Promise<void> {
    const event = EventSchema.parse(input);
    // Each subscriber gets an isolated payload; one cannot change another's fact.
    const handlers = new Set([
      ...(this.handlers.get(event.type) ?? []),
      ...(this.handlers.get("*") ?? []),
    ]);
    for (const handler of handlers) await handler(structuredClone(event));
  }
}

/** Dispatch is a history phase, not an additional authoritative Execution state. */
export type ExecutionPhase = ExecutionState | "dispatched";
export interface ExecutionHistory {
  readonly tenantId: string;
  readonly executionId: string;
  readonly sequence: number;
  readonly phase: ExecutionPhase;
}

const transitions: Partial<
  Record<EventType, { phase: ExecutionPhase; from: readonly ExecutionPhase[] }>
> = {
  "execution.created": { phase: "queued", from: [] },
  "execution.queued": { phase: "queued", from: ["queued"] },
  "queue.enqueued": { phase: "queued", from: ["queued"] },
  "execution.dispatched": { phase: "dispatched", from: ["queued"] },
  "execution.started": { phase: "running", from: ["queued", "dispatched"] },
  "execution.verifying": {
    phase: "verifying",
    from: ["running", "awaiting_approval", "needs_reconciliation"],
  },
  "execution.awaiting_approval": {
    phase: "awaiting_approval",
    from: ["running", "verifying", "needs_reconciliation"],
  },
  "execution.completed": { phase: "completed", from: ["verifying"] },
  "execution.failed": {
    phase: "failed",
    from: [
      "queued",
      "dispatched",
      "running",
      "verifying",
      "awaiting_approval",
      "needs_reconciliation",
      "cancelling",
    ],
  },
  "execution.cancellation_requested": {
    phase: "cancelling",
    from: ["queued", "dispatched", "running", "awaiting_approval", "verifying"],
  },
  "execution.cancelled": { phase: "cancelled", from: ["cancelling"] },
  "queue.timed_out": { phase: "needs_reconciliation", from: ["running"] },
  "budget.exhausted": {
    phase: "budget_exhausted",
    from: [
      "queued",
      "dispatched",
      "running",
      "awaiting_approval",
      "verifying",
      "needs_reconciliation",
      "cancelling",
    ],
  },
};

/** Rebuild from the full ordered stream; reject gaps, mixed tenants and corrupt IDs. */
export function replayExecution(
  events: readonly Event[],
): ExecutionHistory | null {
  let history: ExecutionHistory | null = null;
  let phase: ExecutionPhase = "queued";
  const seen = new Map<string, string>();
  for (const input of events) {
    const event = EventSchema.parse(input);
    const encoded = JSON.stringify(event);
    const previous = seen.get(event.id);
    if (previous !== undefined) {
      if (previous !== encoded)
        throw new Error("Event ID reused with different content");
      continue;
    }
    if (
      event.sequence !== (history ? history.sequence + 1 : 0) ||
      (history &&
        (history.tenantId !== event.tenantId ||
          history.executionId !== event.executionId))
    ) {
      throw new Error("Execution history must be contiguous and tenant scoped");
    }
    const transition = transitions[event.type];
    if (
      (!history &&
        !["execution.created", "execution.queued", "queue.enqueued"].includes(
          event.type,
        )) ||
      (history && transition && !transition.from.includes(history.phase))
    ) {
      throw new Error("Invalid execution lifecycle transition");
    }
    phase = transition?.phase ?? phase;
    history = {
      tenantId: event.tenantId,
      executionId: event.executionId,
      sequence: event.sequence,
      phase,
    };
    seen.set(event.id, encoded);
  }
  return history;
}
