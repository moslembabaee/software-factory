/** Node.js SQL migration runner. Each invocation uses one connection and transaction. */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import pg from "pg";

export const PROJECT_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
export const MIGRATIONS_DIR = join(PROJECT_ROOT, "infra", "migrations");
const DEFAULT_DATABASE_URL =
  "postgres://sf:sf_dev_pw@127.0.0.1:5432/software_factory";

export interface MigrationFile {
  dir: string;
  path: string;
  sortKey: string;
}

interface AppliedMigration {
  dir: string;
  checksum: string;
}

/** Only timestamp directories are executable; the 001_initial_schema alias is ignored. */
export function scanMigrations(directory = MIGRATIONS_DIR): MigrationFile[] {
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^\d{8}(?:\d{6})?_/.test(entry.name))
    .map((entry) => {
      const path = join(directory, entry.name);
      for (const direction of ["up", "down"] as const) {
        if (!existsSync(join(path, `${direction}.sql`))) {
          throw new Error(`Missing ${direction}.sql in migration ${entry.name}`);
        }
      }
      return { dir: entry.name, path, sortKey: entry.name };
    })
    .sort((a, b) => a.sortKey.localeCompare(b.sortKey));
}

export function computeMigrationState(all: MigrationFile[], applied: string[]) {
  const appliedSet = new Set(applied);
  return { applied: [...applied], pending: all.filter((m) => !appliedSet.has(m.dir)) };
}

export function readMigrationSql(path: string, direction: "up" | "down"): string {
  return readFileSync(join(path, `${direction}.sql`), "utf8");
}

export function createPool(): pg.Pool {
  return new pg.Pool({
    connectionString: process.env["DATABASE_URL"] ?? DEFAULT_DATABASE_URL,
    connectionTimeoutMillis: 10_000,
  });
}

function checksum(migration: MigrationFile): string {
  return createHash("sha256")
    .update(readMigrationSql(migration.path, "up"))
    .digest("hex");
}

async function withMigrationLock<T>(
  pool: pg.Pool,
  dryRun: boolean,
  operation: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // All runners share this transaction lock, including initial tracking-table creation.
    await client.query("SELECT pg_advisory_xact_lock(748291005)");
    await client.query(`
      CREATE TABLE IF NOT EXISTS _migrations (
        dir text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now(),
        checksum text NOT NULL
      )
    `);
    const result = await operation(client);
    await client.query(dryRun ? "ROLLBACK" : "COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function getAppliedMigrations(
  client: pg.PoolClient,
  all: MigrationFile[],
): Promise<string[]> {
  const result = await client.query<AppliedMigration>(
    "SELECT dir, checksum FROM _migrations ORDER BY dir",
  );
  for (const applied of result.rows) {
    const migration = all.find((m) => m.dir === applied.dir);
    if (!migration) {
      throw new Error(`Applied migration is missing on disk: ${applied.dir}`);
    }
    if (checksum(migration) !== applied.checksum) {
      throw new Error(`Applied migration has changed: ${applied.dir}`);
    }
  }
  return result.rows.map((row) => row.dir);
}

/** Apply all pending migrations atomically; a failure leaves schema and history unchanged. */
export async function migrateUp(
  pool: pg.Pool,
  dryRun = false,
  directory = MIGRATIONS_DIR,
): Promise<string[]> {
  const all = scanMigrations(directory);
  return withMigrationLock(pool, dryRun, async (client) => {
    const applied = await getAppliedMigrations(client, all);
    const { pending } = computeMigrationState(all, applied);
    for (const migration of pending) {
      if (!dryRun) {
        await client.query(readMigrationSql(migration.path, "up"));
        await client.query(
          "INSERT INTO _migrations (dir, checksum) VALUES ($1, $2)",
          [migration.dir, checksum(migration)],
        );
      }
      console.log(`${dryRun ? "Would apply" : "Applied"}: ${migration.dir}`);
    }
    return pending.map((migration) => migration.dir);
  });
}

/** Roll back one migration, in reverse migration order, atomically with its history entry. */
export async function migrateDown(
  pool: pg.Pool,
  dryRun = false,
  directory = MIGRATIONS_DIR,
): Promise<string | null> {
  const all = scanMigrations(directory);
  return withMigrationLock(pool, dryRun, async (client) => {
    const applied = await getAppliedMigrations(client, all);
    const last = applied.at(-1);
    if (!last) return null;
    const migration = all.find((m) => m.dir === last);
    if (!migration) throw new Error(`Applied migration is missing on disk: ${last}`);
    if (!dryRun) {
      await client.query(readMigrationSql(migration.path, "down"));
      await client.query("DELETE FROM _migrations WHERE dir = $1", [last]);
    }
    console.log(`${dryRun ? "Would roll back" : "Rolled back"}: ${last}`);
    return last;
  });
}

async function main(): Promise<void> {
  const [command, ...flags] = process.argv.slice(2);
  if (
    (command !== "up" && command !== "down") ||
    flags.length > 1 ||
    flags.some((flag) => flag !== "--dry")
  ) {
    console.error("Usage: migrate.ts <up|down> [--dry]");
    process.exitCode = 1;
    return;
  }
  const pool = createPool();
  try {
    if (command === "up") {
      const applied = await migrateUp(pool, flags.includes("--dry"));
      if (applied.length === 0) console.log("No pending migrations.");
    } else {
      const last = await migrateDown(pool, flags.includes("--dry"));
      if (!last) console.log("Nothing to roll back.");
    }
  } finally {
    await pool.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error: unknown) => {
    console.error("Migration error:", error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
