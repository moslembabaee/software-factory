import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { FastifyInstance } from "fastify";
import pg from "pg";
import { afterAll, expect, it } from "vitest";
import { buildApp } from "../../apps/api/src/server.js";

const execute = promisify(execFile);
const root = fileURLToPath(new URL("../../", import.meta.url));
const project = `sf-phase0-smoke-${randomBytes(8).toString("hex")}`;
const environment = { ...process.env, POSTGRES_PORT: "0" };
const composeArgs = [
  "compose",
  "--file",
  fileURLToPath(new URL("../../docker-compose.yml", import.meta.url)),
  "--project-name",
  project,
];
let composeAttempted = false;
let app: FastifyInstance | undefined;
let pool: pg.Pool | undefined;

async function step<T>(label: string, operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (cause) {
    throw new Error(`Phase 0 smoke failed: ${label}`, { cause });
  }
}

async function compose(args: string[], timeout = 30_000): Promise<string> {
  const { stdout } = await execute("docker", [...composeArgs, ...args], {
    cwd: root,
    env: environment,
    timeout,
  });
  return stdout.trim();
}

// afterAll also runs if startup, migrations, seed, DB queries, or HTTP checks fail.
afterAll(async () => {
  const errors: unknown[] = [];
  for (const [label, cleanup] of [
    ["close API listener", async () => app?.close()],
    ["close database pool", async () => pool?.end()],
    [
      `remove Compose project ${project} and its volumes`,
      async () => {
        if (composeAttempted) {
          await compose([
            "down",
            "--volumes",
            "--remove-orphans",
            "--timeout",
            "5",
          ]);
        }
      },
    ],
  ] as const) {
    try {
      await step(label, cleanup);
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length > 0) {
    throw new AggregateError(errors, "Phase 0 smoke cleanup failed");
  }
});

it("boots the Phase 0 skeleton, migrates, seeds, and serves HTTP health", async () => {
  await step("Docker Compose v2 must be installed", () => compose(["version"]));
  await step("Docker daemon must be running and accessible", () =>
    execute("docker", ["info", "--format", "{{.ServerVersion}}"], {
      cwd: root,
      timeout: 10_000,
    }),
  );

  try {
    composeAttempted = true;
    await step("Compose startup and PostgreSQL health check (90s limit)", () =>
      compose(["up", "-d", "--wait", "--wait-timeout", "90"], 120_000),
    );
    const address = await step("discover PostgreSQL's published port", () =>
      compose(["port", "postgres", "5432"]),
    );
    const port = /^127\.0\.0\.1:(\d+)$/.exec(address)?.[1];
    if (!port) {
      throw new Error(
        `Phase 0 smoke: unexpected PostgreSQL address: ${address}`,
      );
    }
    // Always use this test's disposable DB, regardless of ambient DATABASE_URL.
    const connectionString = `postgres://sf:sf_dev_pw@127.0.0.1:${port}/software_factory`;
    async function runScript(script: string): Promise<void> {
      await step(`npm run ${script}`, async () => {
        await execute("npm", ["run", script], {
          cwd: root,
          env: { ...environment, DATABASE_URL: connectionString },
          timeout: 30_000,
        });
      });
    }

    await runScript("migrate:up");
    await runScript("db:seed");
    const database = new pg.Pool({
      connectionString,
      connectionTimeoutMillis: 5_000,
      query_timeout: 5_000,
    });
    pool = database;
    async function tenants() {
      return step("query seeded public.tenants table", async () => {
        const result = await database.query<{ id: string; name: string }>(
          "SELECT id, name FROM public.tenants ORDER BY id",
        );
        expect(
          result.rows.length,
          "Seed must create at least one tenant",
        ).toBeGreaterThanOrEqual(1);
        expect(result.rows.map((row) => row.name)).toContain(
          "Software Factory Development",
        );
        return result.rows;
      });
    }
    const seeded = await tenants();
    // Verify repeatability on an already populated DB as well as a fresh volume.
    await runScript("migrate:up");
    await runScript("db:seed");
    expect(
      await tenants(),
      "Repeated migration and seed must preserve tenants",
    ).toEqual(seeded);

    await step("start Fastify API and GET /health over HTTP", async () => {
      const api = buildApp();
      app = api;
      const address = await api.listen({ port: 0, host: "127.0.0.1" });
      const response = await fetch(`${address}/health`, {
        signal: AbortSignal.timeout(5_000),
      });
      expect(response.status, "API /health must return HTTP 200").toBe(200);
      expect(await response.json()).toMatchObject({
        status: "ok",
        service: "software-factory-api",
        phase: 0,
      });
    });
  } catch (error) {
    // Capture diagnostics before afterAll removes the disposable resources.
    try {
      console.error(await compose(["logs", "--no-color", "--tail", "100"]));
    } catch (logError) {
      console.error("Could not collect Compose logs:", logError);
    }
    throw error;
  }
});
