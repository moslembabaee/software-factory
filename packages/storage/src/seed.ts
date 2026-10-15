/** Minimal, repeatable Phase 0 development seed. Run migrations first. */
import { createPool } from "./migrate.js";

async function main(): Promise<void> {
  const pool = createPool();
  try {
    await pool.query(
      `INSERT INTO tenants (id, name) VALUES ($1, $2)
       ON CONFLICT (id) DO NOTHING`,
      ["00000000-0000-4000-8000-000000000001", "Software Factory Development"],
    );
    console.log("Phase 0 development tenant seeded (existing data preserved).");
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error(
    "Database seed failed; run npm run migrate:up first:",
    error instanceof Error ? error.message : error,
  );
  process.exitCode = 1;
});
