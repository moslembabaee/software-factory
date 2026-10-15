import { z } from "zod";
import { idSchema, metadataSchema, timestampSchema } from "./shared.js";

export const ActorKindSchema = z.enum(["human", "agent", "system", "external"]);

export const ActorSchema = z
  .object({
    id: idSchema,
    tenantId: idSchema,
    subject: z.string(),
    // Optional descriptive fields from docs/06, absent from the baseline table.
    kind: ActorKindSchema.optional(),
    adapterKey: z.string().optional(),
    tags: z.array(z.string()).readonly().optional(),
    metadata: metadataSchema.optional(),
    createdAt: timestampSchema.optional(),
  })
  .readonly();

export type ActorKind = z.infer<typeof ActorKindSchema>;
export type Actor = z.infer<typeof ActorSchema>;
