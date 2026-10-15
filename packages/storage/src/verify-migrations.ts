/** Verify the application schema on the database targeted by the migration CLI. */
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
  "work_queue",
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

  // A table existing does not establish tenant isolation. Check the deployed
  // catalog so a missing security migration or disabled RLS cannot pass.
  const security = await database.query<{
    tablename: string;
    rls_enabled: boolean;
    rls_forced: boolean;
    tenant_policy: boolean;
  }>(`
    SELECT c.relname AS tablename, c.relrowsecurity AS rls_enabled,
      c.relforcerowsecurity AS rls_forced,
      EXISTS (
        SELECT 1 FROM pg_catalog.pg_policy p
        WHERE p.polrelid = c.oid AND p.polname = 'tenant_isolation'
          AND p.polcmd = '*' AND p.polqual IS NOT NULL
          AND p.polwithcheck IS NOT NULL
      ) AS tenant_policy
    FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'r'
  `);
  const byName = new Map(security.rows.map((row) => [row.tablename, row]));
  const unprotected = requiredTables.filter((name) => {
    if (name === "_migrations") return false;
    const table = byName.get(name);
    return !table?.rls_enabled || !table.rls_forced || !table.tenant_policy;
  });
  if (unprotected.length > 0) {
    throw new Error(
      `Migration verification failed; tenant RLS missing or incomplete: ${unprotected.join(", ")}`,
    );
  }
}

async function main(): Promise<void> {
  const pool = createPool();
  try {
    await verifyMigrationSchema(pool);
    console.log(
      "Verified all application tables, migration history, and forced tenant RLS policies.",
    );
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
