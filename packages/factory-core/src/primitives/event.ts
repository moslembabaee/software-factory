import { z } from "zod";
import { counterSchema, idSchema, timestampSchema } from "./shared.js";

// The v1 vocabulary plus durable API, queue and verification lifecycle facts.
export const EventTypeSchema = z.enum([
  "execution.created",
  "execution.queued",
  "execution.dispatched",
  "execution.started",
  "execution.verifying",
  "execution.awaiting_approval",
  "execution.cancellation_requested",
  "queue.enqueued",
  "queue.cancelled",
  "queue.timed_out",
  "agent.step.started",
  "agent.tool.requested",
  "agent.tool.completed",
  "approval.requested",
  "approval.decided",
  "agent.checkpoint.created",
  "agent.checkpoint.recovered",
  "execution.completed",
  "execution.failed",
  "execution.cancelled",
  "budget.exhausted",
]);

export const EventSchema = z
  .object({
    id: idSchema,
    tenantId: idSchema,
    executionId: idSchema,
    sequence: counterSchema,
    type: EventTypeSchema,
    payload: z.json(),
    occurredAt: timestampSchema,
    // Optional envelope metadata from docs/06.
    source: z.string().optional(),
    subjectId: idSchema.optional(),
    recordedAt: timestampSchema.optional(),
    correlationId: idSchema.optional(),
    causationId: idSchema.optional(),
  })
  .readonly();

export type EventType = z.infer<typeof EventTypeSchema>;
export type Event = z.infer<typeof EventSchema>;
