import { z } from "zod";
import { counterSchema, idSchema, timestampSchema } from "./shared.js";

// The normative v1 event vocabulary in docs/33_API_EVENTS_AND_STORAGE_CONTRACTS.md.
export const EventTypeSchema = z.enum([
  "execution.queued",
  "execution.started",
  "agent.step.started",
  "agent.tool.requested",
  "agent.tool.completed",
  "approval.requested",
  "approval.decided",
  "agent.checkpoint.created",
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
