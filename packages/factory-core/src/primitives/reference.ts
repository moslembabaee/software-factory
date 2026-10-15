import { z } from "zod";
import { idSchema, metadataSchema, timestampSchema } from "./shared.js";

export const ReferenceSchema = z
  .object({
    id: idSchema,
    tenantId: idSchema,
    // Reference and relation taxonomies remain open (docs/06).
    kind: z.string(),
    targetId: idSchema,
    uri: z.string().optional(),
    metadata: metadataSchema.optional(),
    createdAt: timestampSchema.optional(),
  })
  .readonly();

export type Reference = z.infer<typeof ReferenceSchema>;
