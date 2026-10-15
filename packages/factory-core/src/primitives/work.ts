import { z } from "zod";
import { counterSchema, idSchema, timestampSchema } from "./shared.js";

// docs/06, including the v3 distinct terminal outcomes and operational substates.
export const WorkStateSchema = z.enum([
  "open",
  "active",
  "blocked",
  "waiting_approval",
  "paused",
  "completed",
  "cancelled",
  "failed",
]);

export const WorkSchema = z
  .object({
    id: idSchema,
    tenantId: idSchema,
    projectId: idSchema,
    createdBy: idSchema,
    objective: z.string(),
    state: WorkStateSchema,
    version: counterSchema,
    createdAt: timestampSchema,
  })
  .readonly();

export type WorkState = z.infer<typeof WorkStateSchema>;
export type Work = z.infer<typeof WorkSchema>;
