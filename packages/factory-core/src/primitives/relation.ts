import { z } from "zod";
import { idSchema, metadataSchema, timestampSchema } from "./shared.js";

export const RelationSchema = z
  .object({
    id: idSchema,
    tenantId: idSchema,
    fromRef: idSchema,
    toRef: idSchema,
    kind: z.string(),
    createdAt: timestampSchema.optional(),
    metadata: metadataSchema.optional(),
  })
  .readonly();

export type Relation = z.infer<typeof RelationSchema>;
