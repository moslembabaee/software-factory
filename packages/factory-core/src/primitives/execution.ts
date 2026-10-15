import { z } from "zod";
import {
  counterSchema,
  idSchema,
  metadataSchema,
  timestampSchema,
  usdSchema,
} from "./shared.js";

// Exactly the execution state CHECK constraint in docs/45_STORAGE_SCHEMA.sql.
export const ExecutionStateSchema = z.enum([
  "queued",
  "running",
  "awaiting_approval",
  "verifying",
  "needs_reconciliation",
  "cancelling",
  "completed",
  "failed",
  "cancelled",
  "budget_exhausted",
]);

// Valid numeric(18,6) amounts stringify without exponent notation. Compare
// integer microdollars so floating point addition cannot hide a small overage.
function microUsd(amount: number): bigint {
  const [whole = "0", fraction = ""] = amount.toString().split(".");
  return BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, "0"));
}

export const ExecutionSchema = z
  .object({
    id: idSchema,
    tenantId: idSchema,
    workId: idSchema,
    parentExecutionId: idSchema.nullable(),
    state: ExecutionStateSchema,
    version: counterSchema,
    budgetCapUsd: usdSchema,
    reservedUsd: usdSchema,
    spentUsd: usdSchema,
    createdAt: timestampSchema,
    // Optional execution metadata from docs/06.
    actorId: idSchema.optional(),
    workerId: z.string().optional(),
    attemptNo: counterSchema.optional(),
    sandboxRef: z.string().optional(),
    externalRunRef: z.string().optional(),
    startedAt: timestampSchema.optional(),
    endedAt: timestampSchema.optional(),
    metadata: metadataSchema.optional(),
  })
  .refine(
    ({ reservedUsd, spentUsd, budgetCapUsd }) => {
      // Field validators report malformed amounts before decimal conversion.
      if (
        ![reservedUsd, spentUsd, budgetCapUsd].every(
          (amount) => usdSchema.safeParse(amount).success,
        )
      ) {
        return true;
      }
      return (
        microUsd(reservedUsd) + microUsd(spentUsd) <= microUsd(budgetCapUsd)
      );
    },
    {
      message: "Reserved and spent USD must not exceed the budget cap",
      path: ["budgetCapUsd"],
    },
  )
  .readonly();

export type ExecutionState = z.infer<typeof ExecutionStateSchema>;
export type Execution = z.infer<typeof ExecutionSchema>;
