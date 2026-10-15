/** Verify the Phase 0 schema on the database targeted by the migration CLI. */
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type pg from "pg";
import { createPool } from "./migrate.js";

const requiredTables = [
  "_migrations",
  "tenants",
  "actors",
  "projects",
  "works",
  "executions",
  "events",
  "outbox",
  "idempotency_keys",
  "agent_runs",
  "worker_leases",
  "approvals",
  "external_effects",
  "budget_ledger",
  "artifacts",
  "references",
  "relations",
];

export async function verifyMigrationSchema(
  database: Pick<pg.Pool, "query">,
): Promise<void> {
  const result = await database.query<{ tablename: string }>(
    "SELECT tablename FROM pg_catalog.pg_tables WHERE schemaname = 'public'",
  );
  const actual = new Set(result.rows.map((row) => row.tablename));
  const missing = requiredTables.filter((name) => !actual.has(name));
  if (missing.length > 0) {
    throw new Error(
      `Migration verification failed; missing tables: ${missing.join(", ")}`,
    );
  }
}

async function main(): Promise<void> {
  const pool = createPool();
  try {
    await verifyMigrationSchema(pool);
    console.log("Verified all 16 Phase 0 tables and migration history table.");
  } finally {
    await pool.end();
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
