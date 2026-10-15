import { z } from "zod";

// Domain values use camelCase; storage adapters map PostgreSQL column names.
export const idSchema = z.uuid();
export const timestampSchema = z.iso.datetime({ offset: true });
// PostgreSQL bigint values are represented only within JS's safe integer range.
export const counterSchema = z.int().nonnegative();
export const metadataSchema = z.record(z.string(), z.json()).readonly();

// numeric(18,6): six fractional digits and fewer than twelve integral digits.
export const usdSchema = z
  .number()
  .nonnegative()
  .lt(1_000_000_000_000)
  .multipleOf(0.000001);
