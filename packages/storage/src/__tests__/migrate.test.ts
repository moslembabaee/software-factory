import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  closeSync,
  mkdtempSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type pg from "pg";
import {
  computeMigrationState,
  MIGRATIONS_DIR,
  migrateDown,
  migrateUp,
  PROJECT_ROOT,
  readMigrationSql,
  scanMigrations,
} from "../migrate.js";

const initialDir = "20261015_001_initial_schema";
const initialPath = join(MIGRATIONS_DIR, initialDir);
const upSql = readMigrationSql(initialPath, "up");
const initialChecksum = createHash("sha256").update(upSql).digest("hex");
const tables = [
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
const temporaryDirectories: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function fixture(): string {
  const directory = mkdtempSync(join(tmpdir(), "sf-migrations-"));
  temporaryDirectories.push(directory);
  return directory;
}

function addMigration(directory: string, name: string): void {
  mkdirSync(join(directory, name));
  writeFileSync(join(directory, name, "up.sql"), "SELECT 1;");
  writeFileSync(join(directory, name, "down.sql"), "SELECT 2;");
}

function database(applied: { dir: string; checksum: string }[] = []) {
  const query = vi
    .fn<
      (sql: string, values?: unknown[]) => Promise<{ rows: typeof applied }>
    >()
    .mockImplementation((sql) =>
      Promise.resolve({
        rows: sql.startsWith("SELECT dir, checksum") ? applied : [],
      }),
    );
  const release = vi.fn();
  const client = { query, release };
  const pool = { connect: vi.fn().mockResolvedValue(client) };
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  return {
    pool: pool as unknown as pg.Pool,
    query,
    release,
    statements: () => query.mock.calls.map(([sql]) => sql),
  };
}

describe("canonical initial migration", () => {
  it("matches the normative schema byte for byte, including enforcement annotations", () => {
    const normative = readFileSync(
      join(PROJECT_ROOT, "docs/45_STORAGE_SCHEMA.sql"),
    );
    expect(readFileSync(join(initialPath, "up.sql")).equals(normative)).toBe(
      true,
    );
    expect(
      readFileSync(join(MIGRATIONS_DIR, "001_initial_schema/up.sql")).equals(
        normative,
      ),
    ).toBe(true);
    expect(upSql).toContain("FORCE ROW LEVEL SECURITY");
    expect(upSql).toContain(
      "preventing UPDATE/DELETE on events and settled ledger",
    );
  });

  it("drops exactly the sixteen tables in reverse dependency order without CASCADE", () => {
    const down = readMigrationSql(initialPath, "down");
    const drops = [...down.matchAll(/DROP TABLE IF EXISTS "?(\w+)"?;/g)].map(
      (match) => match[1],
    );
    expect(drops).toEqual([...tables].reverse());
    expect(down).not.toMatch(/\bCASCADE\b/i);
    // pgcrypto may have existed before this migration; rollback must preserve it.
    expect(down).not.toMatch(/DROP EXTENSION/i);
  });

  it("discovers the timestamp migration once, ignoring its compatibility alias", () => {
    expect(scanMigrations().map((migration) => migration.dir)).toEqual([
      initialDir,
    ]);
  });
});

describe("migration discovery", () => {
  it("sorts by the complete timestamp and name, including same-day migrations", () => {
    const directory = fixture();
    addMigration(directory, "20261015_002_second");
    addMigration(directory, "20261014_001_first");
    addMigration(directory, "20261015_001_first");
    mkdirSync(join(directory, "notes"));
    expect(scanMigrations(directory).map((migration) => migration.dir)).toEqual(
      ["20261014_001_first", "20261015_001_first", "20261015_002_second"],
    );
  });

  it("rejects incomplete migrations instead of silently skipping them", () => {
    const directory = fixture();
    addMigration(directory, initialDir);
    rmSync(join(directory, initialDir, "down.sql"));
    expect(() => scanMigrations(directory)).toThrow("Missing down.sql");
  });

  it("reports only unapplied migrations as pending", () => {
    const migrations = scanMigrations();
    expect(computeMigrationState(migrations, []).pending).toEqual(migrations);
    expect(computeMigrationState(migrations, [initialDir]).pending).toEqual([]);
  });
});

describe("transactional runner", () => {
  it("locks before reading history and commits schema with its checksum", async () => {
    const db = database();
    expect(await migrateUp(db.pool)).toEqual([initialDir]);
    const statements = db.statements();
    expect(statements[0]).toBe("BEGIN");
    expect(statements[1]).toContain("pg_advisory_xact_lock");
    expect(statements[2]).toContain("CREATE TABLE IF NOT EXISTS _migrations");
    expect(db.query).toHaveBeenCalledWith(upSql);
    expect(db.query).toHaveBeenCalledWith(
      "INSERT INTO _migrations (dir, checksum) VALUES ($1, $2)",
      [initialDir, initialChecksum],
    );
    expect(statements.at(-1)).toBe("COMMIT");
    expect(db.release).toHaveBeenCalledOnce();
  });

  it("does not execute an already applied migration", async () => {
    const db = database([{ dir: initialDir, checksum: initialChecksum }]);
    expect(await migrateUp(db.pool)).toEqual([]);
    expect(db.statements()).not.toContain(upSql);
  });

  it("rolls back schema and tracking changes when SQL fails, and releases the connection", async () => {
    const db = database();
    db.query.mockImplementation((sql) => {
      if (sql === upSql) return Promise.reject(new Error("SQL failed"));
      return Promise.resolve({ rows: [] });
    });
    await expect(migrateUp(db.pool)).rejects.toThrow("SQL failed");
    expect(db.statements().at(-1)).toBe("ROLLBACK");
    expect(db.statements()).not.toContain("COMMIT");
    expect(db.statements().some((sql) => sql.startsWith("INSERT INTO"))).toBe(
      false,
    );
    expect(db.release).toHaveBeenCalledOnce();
  });

  it("rolls back one migration and its history entry together", async () => {
    const db = database([{ dir: initialDir, checksum: initialChecksum }]);
    expect(await migrateDown(db.pool)).toBe(initialDir);
    expect(db.query).toHaveBeenCalledWith(
      readMigrationSql(initialPath, "down"),
    );
    expect(db.query).toHaveBeenCalledWith(
      "DELETE FROM _migrations WHERE dir = $1",
      [initialDir],
    );
    expect(db.statements().at(-1)).toBe("COMMIT");
    expect(db.release).toHaveBeenCalledOnce();
  });

  it("preserves history when rollback SQL fails", async () => {
    const db = database([{ dir: initialDir, checksum: initialChecksum }]);
    const downSql = readMigrationSql(initialPath, "down");
    db.query.mockImplementation((sql) => {
      if (sql === downSql) return Promise.reject(new Error("dependent object"));
      return Promise.resolve({
        rows: sql.startsWith("SELECT dir, checksum")
          ? [{ dir: initialDir, checksum: initialChecksum }]
          : [],
      });
    });
    await expect(migrateDown(db.pool)).rejects.toThrow("dependent object");
    expect(db.statements().at(-1)).toBe("ROLLBACK");
    expect(db.statements().some((sql) => sql.startsWith("DELETE FROM"))).toBe(
      false,
    );
    expect(db.release).toHaveBeenCalledOnce();
  });

  it("handles rollback before any migration has been applied", async () => {
    const db = database();
    expect(await migrateDown(db.pool)).toBeNull();
    expect(db.statements()).not.toContain(
      readMigrationSql(initialPath, "down"),
    );
  });

  it("previews up and down without changing schema or tracking state", async () => {
    const up = database();
    expect(await migrateUp(up.pool, true)).toEqual([initialDir]);
    expect(up.statements()).not.toContain(upSql);
    expect(up.statements().at(-1)).toBe("ROLLBACK");
    const down = database([{ dir: initialDir, checksum: initialChecksum }]);
    expect(await migrateDown(down.pool, true)).toBe(initialDir);
    expect(down.statements()).not.toContain(
      readMigrationSql(initialPath, "down"),
    );
    expect(down.statements().at(-1)).toBe("ROLLBACK");
  });

  it("rejects missing or changed applied migrations", async () => {
    const missing = database([
      { dir: "20261014_001_missing", checksum: "abc" },
    ]);
    await expect(migrateUp(missing.pool)).rejects.toThrow("missing on disk");
    expect(missing.statements().at(-1)).toBe("ROLLBACK");
    const changed = database([{ dir: initialDir, checksum: "changed" }]);
    await expect(migrateDown(changed.pool)).rejects.toThrow("has changed");
    expect(changed.statements().at(-1)).toBe("ROLLBACK");
  });
});

describe("migration CLI", () => {
  it.each(["up", "down"])(
    "runs the migrate:%s npm script without requiring an IPC server",
    (direction) => {
      const outputPath = join(fixture(), "npm-cli.log");
      const outputFd = openSync(outputPath, "w");
      try {
        const result = spawnSync(
          "npm",
          ["run", `migrate:${direction}`, "--", "--invalid"],
          {
            cwd: PROJECT_ROOT,
            stdio: ["ignore", outputFd, outputFd],
            timeout: 15_000,
          },
        );
        expect(result.error).toBeUndefined();
        expect(result.status).toBe(1);
        expect(readFileSync(outputPath, "utf8")).toContain(
          "Usage: migrate.ts <up|down> [--dry]",
        );
      } finally {
        closeSync(outputFd);
      }
    },
  );

  it.each([[], ["invalid"], ["up", "--invalid"], ["down", "--dry", "extra"]])(
    "rejects invalid arguments %j without connecting to PostgreSQL",
    (...args) => {
      const outputPath = join(fixture(), "cli.log");
      const outputFd = openSync(outputPath, "w");
      try {
        const result = spawnSync(
          process.execPath,
          ["--import", "tsx", "packages/storage/src/migrate.ts", ...args],
          {
            cwd: PROJECT_ROOT,
            stdio: ["ignore", outputFd, outputFd],
            timeout: 15_000,
          },
        );
        expect(result.error).toBeUndefined();
        expect(result.status).toBe(1);
        const output = readFileSync(outputPath, "utf8");
        expect(output).toContain("Usage: migrate.ts <up|down> [--dry]");
        expect(output).not.toContain("Invalid URL");
      } finally {
        closeSync(outputFd);
      }
    },
  );
});
