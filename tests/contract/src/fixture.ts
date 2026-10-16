import type { FastifyInstance, FastifySchema } from "fastify";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileAskRoadmap } from "../../../apps/api/src/ask-roadmap.js";
import type pg from "pg";
import { vi } from "vitest";
import type { TenantDatabase } from "@software-factory/storage";
import { buildApp } from "../../../apps/api/src/server.js";
import type { Endpoint } from "./openapi.js";

export const tenantId = "11111111-1111-4111-8111-111111111111";
export const actorId = "22222222-2222-4222-8222-222222222222";
export const resourceId = "33333333-3333-4333-8333-333333333333";
export const sha = "a".repeat(40);
export const digest = "b".repeat(64);
export const headers = { "idempotency-key": "contract-test-key" };
export const event = {
  id: resourceId,
  execution_id: resourceId,
  sequence: "0",
  type: "execution.created",
  occurred_at: new Date("2026-01-01T00:00:00Z"),
  payload: { nested: { keep: true }, count: 1 },
};
export const artifact = {
  id: resourceId,
  sha256: digest,
  media_type: "text/plain",
};
const rows: Record<string, Record<string, unknown>> = {
  projects: { name: "Project" },
  actors: { subject: "user:contract" },
  works: {
    project_id: resourceId,
    objective: "Build it",
    state: "open",
    version: "0",
  },
  executions: {
    work_id: resourceId,
    state: "queued",
    version: "0",
    parent_execution_id: null,
    created_at: new Date("2026-01-01T00:00:00Z"),
  },
  references: { kind: "work", target_id: resourceId },
  relations: { kind: "depends_on", from_ref: resourceId, to_ref: actorId },
};
export const payloads: Record<string, Record<string, unknown>> = {
  updateBuildBudget: { revision: "a".repeat(64), budget_cap_usd: 5 },
  approveBuildTask: { revision: "a".repeat(64) },
  previewAskPlan: { description: "Build a dashboard" },
  acceptAskPlan: { description: "Build a dashboard", accepted: true },
  createProject: { name: "Project" },
  updateProject: { name: "Updated" },
  createWork: { project_id: resourceId, objective: "Build it" },
  updateWork: { objective: "Updated", version: 0 },
  createExecution: {
    base_sha: sha,
    budget_cap_usd: 10,
    parent_execution_id: resourceId,
  },
  createReference: { kind: "work", target_id: resourceId },
  updateReference: { kind: "artifact", target_id: actorId },
  createRelation: { kind: "depends_on", from_ref: resourceId, to_ref: actorId },
  updateRelation: { kind: "related", from_ref: actorId, to_ref: resourceId },
};
export function request(endpoint: Endpoint) {
  return {
    method: endpoint.method,
    url: endpoint.url.replace("{id}", resourceId).replace("{taskId}", "T-1"),
    headers,
    ...(payloads[endpoint.operation.operationId]
      ? { payload: payloads[endpoint.operation.operationId] }
      : {}),
  };
}
interface Saved {
  request_hash: unknown;
  response_status: number | null;
  response_json: unknown;
}
export async function fixture(authenticated = true) {
  const saved = new Map<string, Saved>();
  const query = vi
    .fn<
      (
        sql: string,
        values?: unknown[],
      ) => Promise<{ rows: Record<string, unknown>[] }>
    >()
    .mockImplementation((sql, values = []) => {
      const key = JSON.stringify(values.slice(0, 4));
      if (sql.startsWith("INSERT INTO idempotency_keys")) {
        if (!saved.has(key))
          saved.set(key, {
            request_hash: values[4],
            response_status: null,
            response_json: null,
          });
        return Promise.resolve({ rows: [] });
      }
      if (sql.startsWith("SELECT request_hash"))
        return Promise.resolve({ rows: [{ ...saved.get(key) }] });
      if (sql.startsWith("UPDATE idempotency_keys")) {
        const record = saved.get(key);
        if (!record) throw new Error("Missing idempotency reservation");
        record.response_status = Number(values[4]);
        record.response_json = JSON.parse(String(values[5])) as unknown;
        return Promise.resolve({ rows: [] });
      }
      if (sql.startsWith("SELECT * FROM events"))
        return Promise.resolve({ rows: [event] });
      if (sql.includes("FROM agent_checkpoints"))
        return Promise.resolve({
          rows: [
            {
              id: resourceId,
              sequence: "1",
              step: 3,
              worker_id: "worker",
              fence: "1",
              created_at: new Date("2026-01-01T00:00:00Z"),
            },
          ],
        });
      if (sql.startsWith("SELECT id, sha256"))
        return Promise.resolve({ rows: [artifact] });
      if (sql.startsWith("SELECT id FROM actors"))
        return Promise.resolve({ rows: [{ id: actorId }] });
      const table =
        /(?:FROM|INTO|UPDATE) "?(projects|works|executions|actors|references|relations)\b/.exec(
          sql,
        )?.[1];
      return Promise.resolve({
        rows: table
          ? [{ id: resourceId, tenant_id: tenantId, ...rows[table] }]
          : [],
      });
    });
  const database: TenantDatabase = {
    withTenant: (_identity, operation) =>
      operation({ query } as unknown as pg.PoolClient),
  };
  const withTenant = vi.spyOn(database, "withTenant");
  const directory = await mkdtemp(join(tmpdir(), "sf-contract-"));
  const roadmapPath = join(directory, "ROADMAP.json");
  await writeFile(roadmapPath, JSON.stringify({ tasks: [] }));
  const app: FastifyInstance = buildApp({
    database,
    buildRoadmap: {
      setBudget: () =>
        Promise.resolve({ tasks: [], current_task_id: null, logs: [] }),
      snapshot: () =>
        Promise.resolve({ tasks: [], current_task_id: null, logs: [] }),
      approve: () =>
        Promise.resolve({ tasks: [], current_task_id: null, logs: [] }),
    },
    askRoadmap: new FileAskRoadmap(roadmapPath),
    ...(authenticated ? { authenticate: () => ({ tenantId, actorId }) } : {}),
  });
  app.addHook("onClose", async () =>
    rm(directory, { recursive: true, force: true }),
  );
  const routes = new Map<string, FastifySchema>();
  app.addHook("onRoute", (route) => {
    // SSE transport is exercised with streaming injection in build.test.ts; this suite validates JSON.
    if (route.method === "HEAD" || route.url.endsWith("/build/stream")) return;
    routes.set(
      `${String(route.method)} ${route.url.replace(/:([^/]+)/g, "{$1}")}`,
      route.schema ?? {},
    );
  });
  app.addHook("onRequest", (request, _reply, done) => {
    if (request.routeOptions.url === "/health")
      routes.set("GET /health", request.routeOptions.schema ?? {});
    done();
  });
  await app.ready();
  return { app, database, withTenant, query, routes };
}
