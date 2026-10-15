import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import type pg from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  AskPlanSchema,
  AskAcceptanceSchema,
} from "@software-factory/factory-core";
import type { TenantDatabase } from "@software-factory/storage";
import { buildApp } from "../server.js";
import { FileAskRoadmap } from "../ask-roadmap.js";

const tenantId = "00000000-0000-4000-8000-000000000001";
const actorId = "00000000-0000-4000-8000-000000000002";
const projectId = "00000000-0000-4000-8000-000000000003";
const otherTenant = "00000000-0000-4000-8000-000000000004";
const url = `/api/v1/projects/${projectId}/ask`;
const payload = { description: "Build a task dashboard" };
const headers = { "idempotency-key": "ask-test-acceptance" };
const cleanups: (() => Promise<unknown>)[] = [];
const roadmapSchema = z.looseObject({ tasks: z.array(z.unknown()) });
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture(authenticated = true) {
  const directory = await mkdtemp(join(tmpdir(), "sf-ask-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "ROADMAP.json");
  const initial = JSON.stringify({
    project: "Factory",
    custom: { preserve: true },
    current_task_id: "T-009",
    tasks: [{ id: "T-009", status: "in_progress" }],
  });
  await writeFile(path, initial);
  const query = vi
    .fn<
      (
        sql: string,
        values?: unknown[],
      ) => Promise<{ rows: Record<string, unknown>[] }>
    >()
    .mockResolvedValue({ rows: [{ id: projectId }] });
  const database: TenantDatabase = {
    withTenant: (_identity, operation) =>
      operation({ query } as unknown as pg.PoolClient),
  };
  const withTenant = vi.spyOn(database, "withTenant");
  const roadmap = new FileAskRoadmap(path);
  const accept = vi.spyOn(roadmap, "accept");
  const app: FastifyInstance = buildApp({
    database,
    askRoadmap: roadmap,
    ...(authenticated ? { authenticate: () => ({ tenantId, actorId }) } : {}),
  });
  cleanups.push(() => app.close());
  return { app, path, initial, query, withTenant, accept };
}

describe("Ask preview and explicit task acceptance", () => {
  it("previews without writing roadmap or SQL mutations", async () => {
    const { app, path, initial, query, accept } = await fixture();
    const response = await app.inject({ method: "POST", url, payload });
    expect(response.statusCode, response.body).toBe(200);
    expect(AskPlanSchema.parse(response.json<unknown>()).tasks).toHaveLength(3);
    expect(await readFile(path, "utf8")).toBe(initial);
    expect(accept).not.toHaveBeenCalled();
    expect(query.mock.calls.every(([sql]) => sql.startsWith("SELECT"))).toBe(
      true,
    );
  });

  it("appends pending tasks with trusted identity, agents and verification gates", async () => {
    const { app, path, withTenant, query } = await fixture();
    const response = await app.inject({
      method: "POST",
      url: `${url}/tasks`,
      headers,
      payload: { ...payload, accepted: true },
    });
    expect(response.statusCode, response.body).toBe(201);
    const body = AskAcceptanceSchema.parse(response.json<unknown>());
    expect(body.tasks).toHaveLength(3);
    expect(body.request_id).toBe(response.headers["x-request-id"]);
    for (const task of body.tasks)
      expect(task).toMatchObject({
        status: "pending",
        tenant_id: tenantId,
        created_by: actorId,
        project_id: projectId,
        retry_count: 0,
        verification_cmd: "npm run typecheck && npm test",
      });
    const saved: unknown = JSON.parse(await readFile(path, "utf8"));
    expect(saved).toMatchObject({
      custom: { preserve: true },
      current_task_id: "T-009",
      tasks: [{ id: "T-009", status: "in_progress" }, ...body.tasks],
    });
    expect(withTenant).toHaveBeenCalledWith(
      { tenantId, actorId },
      expect.any(Function),
    );
    expect(query).toHaveBeenCalledWith(
      "SELECT id FROM projects WHERE tenant_id = $1 AND id = $2",
      [tenantId, projectId],
    );
  });

  it("serializes concurrent retries and persists receipts across server restarts", async () => {
    const { app, path, accept } = await fixture();
    const request = {
      method: "POST" as const,
      url: `${url}/tasks`,
      headers,
      payload: { ...payload, accepted: true },
    };
    const responses = await Promise.all(
      Array.from({ length: 5 }, () => app.inject(request)),
    );
    expect(responses.map((response) => response.statusCode)).toEqual([
      201, 201, 201, 201, 201,
    ]);
    const tasks = AskAcceptanceSchema.parse(
      responses[0]?.json<unknown>(),
    ).tasks;
    expect(
      responses.every(
        (response) =>
          JSON.stringify(
            AskAcceptanceSchema.parse(response.json<unknown>()).tasks,
          ) === JSON.stringify(tasks),
      ),
    ).toBe(true);
    expect(
      roadmapSchema.parse(JSON.parse(await readFile(path, "utf8"))).tasks,
    ).toHaveLength(4);
    const [plan, identity, project, key] = accept.mock.calls[0] ?? [];
    if (!plan || !identity || !project || !key)
      throw new Error("Missing acceptance");
    expect(
      await new FileAskRoadmap(path).accept(plan, identity, project, key),
    ).toEqual(tasks);
  });

  it("keeps independent concurrent submissions and scopes keys by tenant", async () => {
    const { app, path, accept } = await fixture();
    const results = await Promise.all(
      ["one", "two", "three"].map((key) =>
        app.inject({
          method: "POST",
          url: `${url}/tasks`,
          headers: { "idempotency-key": `independent-${key}` },
          payload: { description: key, accepted: true },
        }),
      ),
    );
    expect(results.every((result) => result.statusCode === 201)).toBe(true);
    expect(
      roadmapSchema.parse(JSON.parse(await readFile(path, "utf8"))).tasks,
    ).toHaveLength(10);
    const [plan, , project, key] = accept.mock.calls[0] ?? [];
    if (!plan || !project || !key) throw new Error("Missing acceptance");
    const tasks = await new FileAskRoadmap(path).accept(
      plan,
      { tenantId: otherTenant, actorId },
      project,
      key,
    );
    expect(tasks[0]?.tenant_id).toBe(otherTenant);
    expect(
      roadmapSchema.parse(JSON.parse(await readFile(path, "utf8"))).tasks,
    ).toHaveLength(13);
  });

  it("returns a conflict when a retry key is reused with changed requirements", async () => {
    const { app, path } = await fixture();
    await app.inject({
      method: "POST",
      url: `${url}/tasks`,
      headers,
      payload: { ...payload, accepted: true },
    });
    const before = await readFile(path, "utf8");
    const response = await app.inject({
      method: "POST",
      url: `${url}/tasks`,
      headers,
      payload: { description: "Different plan", accepted: true },
    });
    expect(response.statusCode).toBe(409);
    expect(await readFile(path, "utf8")).toBe(before);
  });

  it.each(["", "/tasks"])(
    "requires trusted authentication on %s",
    async (suffix) => {
      const { app, path, initial, withTenant, accept } = await fixture(false);
      const response = await app.inject({
        method: "POST",
        url: `${url}${suffix}`,
        headers: { ...headers, "x-tenant-id": tenantId },
        payload: suffix ? { ...payload, accepted: true } : payload,
      });
      expect(response.statusCode).toBe(401);
      expect(withTenant).not.toHaveBeenCalled();
      expect(accept).not.toHaveBeenCalled();
      expect(await readFile(path, "utf8")).toBe(initial);
    },
  );

  it.each(["", "/tasks"])(
    "hides missing or cross-tenant projects on %s",
    async (suffix) => {
      const { app, query, accept } = await fixture();
      query.mockImplementation((sql) =>
        Promise.resolve({
          rows: sql.includes("FROM actors") ? [{ id: actorId }] : [],
        }),
      );
      const response = await app.inject({
        method: "POST",
        url: `${url}${suffix}`,
        headers,
        payload: suffix ? { ...payload, accepted: true } : payload,
      });
      expect(response.statusCode).toBe(404);
      expect(accept).not.toHaveBeenCalled();
    },
  );

  it.each([
    { description: " " },
    { description: 123 },
    { description: "x".repeat(10001) },
    { ...payload, accepted: false },
    { ...payload, tenant_id: otherTenant, accepted: true },
    { ...payload, verification_cmd: "echo skip", accepted: true },
  ])(
    "rejects invalid or forged acceptance before storage: %j",
    async (body) => {
      const { app, query, accept } = await fixture();
      const response = await app.inject({
        method: "POST",
        url: `${url}/tasks`,
        headers,
        payload: body,
      });
      expect(response.statusCode).toBe(422);
      expect(query).not.toHaveBeenCalled();
      expect(accept).not.toHaveBeenCalled();
    },
  );

  it("preserves a corrupt roadmap and returns a sanitized error", async () => {
    const { app, path } = await fixture();
    await writeFile(path, "not json");
    const response = await app.inject({
      method: "POST",
      url: `${url}/tasks`,
      headers,
      payload: { ...payload, accepted: true },
    });
    expect(response.statusCode).toBe(500);
    expect(response.body).not.toContain(path);
    expect(await readFile(path, "utf8")).toBe("not json");
  });
});
