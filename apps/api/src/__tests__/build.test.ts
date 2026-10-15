import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { Readable } from "node:stream";
import type { FastifyInstance } from "fastify";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type pg from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BuildSnapshotSchema,
  type BuildSnapshot,
} from "@software-factory/factory-core";
import type { TenantDatabase } from "@software-factory/storage";
import { FileBuildRoadmap } from "../build-roadmap.js";
import { buildApp } from "../server.js";

const tenantId = "00000000-0000-4000-8000-000000000001";
const actorId = "00000000-0000-4000-8000-000000000002";
const projectId = "00000000-0000-4000-8000-000000000003";
const otherId = "00000000-0000-4000-8000-000000000004";
const identity = { tenantId, actorId };
const url = `/api/v1/projects/${projectId}/build`;
const task = {
  id: "T-ONE",
  title: "Build a dashboard",
  description: "Task details",
  phase: "Build",
  status: "pending",
  tenant_id: tenantId,
  project_id: projectId,
  assigned_agent: "codex",
  retry_count: 0,
  github_issue_number: 42,
};
const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function fixture(authenticated = true) {
  const directory = await mkdtemp(join(tmpdir(), "sf-build-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "ROADMAP.json");
  const data = {
    custom: "preserved",
    current_task_id: "T-OTHER",
    tasks: [
      task,
      { ...task, id: "T-OTHER", tenant_id: otherId, status: "in_progress" },
      { ...task, id: "T-PROJECT", project_id: otherId },
      { id: "T-LEGACY", status: "pending", title: "Private repository task" },
    ],
  };
  await writeFile(path, JSON.stringify(data));
  await mkdir(join(directory, "logs"));
  const log = {
    id: "00000000-0000-4000-8000-000000000005",
    task_id: task.id,
    source: "orchestrator",
    timestamp: "2026-10-15T00:00:00Z",
    message: "Dispatching task",
  };
  await writeFile(
    join(directory, "logs/build.jsonl"),
    `${JSON.stringify(log)}\n${JSON.stringify({ ...log, task_id: "T-OTHER", message: "Tenant secret" })}\n`,
  );
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
  const roadmap = new FileBuildRoadmap(path);
  const snapshot = vi.spyOn(roadmap, "snapshot");
  const approve = vi.spyOn(roadmap, "approve");
  const app = buildApp({
    database,
    buildRoadmap: roadmap,
    ...(authenticated ? { authenticate: () => identity } : {}),
  });
  cleanups.push(() => app.close());
  return {
    app,
    roadmap,
    path,
    directory,
    data,
    query,
    withTenant,
    snapshot,
    approve,
  };
}
const body = (response: { json(): unknown }) =>
  BuildSnapshotSchema.parse(response.json());

describe("Build dashboard access and approvals", () => {
  it("projects only tenant/project tasks, current task and scoped logs after RLS access checks", async () => {
    const { app, query, withTenant } = await fixture();
    const response = await app.inject(url);
    expect(response.statusCode, response.body).toBe(200);
    const snapshot = body(response);
    expect(snapshot.tasks.map((item) => item.id)).toEqual([task.id]);
    expect(snapshot.tasks[0]).toMatchObject({
      github_issue_number: 42,
      status: "pending",
    });
    expect(snapshot.current_task_id).toBeNull();
    expect(snapshot.logs.map((item) => item.message)).toEqual([
      "Dispatching task",
    ]);
    expect(response.body).not.toMatch(
      /Tenant secret|Private repository|T-OTHER|tenant_id/,
    );
    expect(withTenant).toHaveBeenCalledWith(identity, expect.any(Function));
    expect(query).toHaveBeenCalledWith(
      "SELECT id FROM projects WHERE tenant_id = $1 AND id = $2",
      [tenantId, projectId],
    );
  });

  it("atomically approves one task and safely retries after a lost response or restart", async () => {
    const { app, path, roadmap } = await fixture();
    const revision = (await roadmap.snapshot(identity, projectId)).tasks[0]
      ?.revision;
    if (!revision) throw new Error("Missing revision");
    const request = {
      method: "POST" as const,
      url: `${url}/tasks/${task.id}/approve`,
      payload: { revision },
    };
    const responses = await Promise.all(
      Array.from({ length: 5 }, () => app.inject(request)),
    );
    expect(responses.map((result) => result.statusCode)).toEqual([
      200, 200, 200, 200, 200,
    ]);
    for (const response of responses)
      expect(body(response).tasks[0]?.status).toBe("approved");
    const saved = JSON.parse(await readFile(path, "utf8")) as unknown;
    expect(saved).toMatchObject({
      custom: "preserved",
      current_task_id: "T-OTHER",
      tasks: [
        { status: "approved", build_approval: { actor_id: actorId } },
        { status: "in_progress" },
        { status: "pending" },
        { status: "pending" },
      ],
    });
    expect(
      (
        await new FileBuildRoadmap(path).approve(
          identity,
          projectId,
          task.id,
          revision,
        )
      ).tasks[0]?.status,
    ).toBe("approved");
    const journal = await readFile(
      join(dirname(path), "logs/build.jsonl"),
      "utf8",
    );
    expect(journal.match(/Task approved for dispatch/g)).toHaveLength(1);
  });

  it.each(["in_progress", "completed", "cancelled"])(
    "rejects approval after task changed to %s",
    async (status) => {
      const { app, path, data, roadmap } = await fixture();
      const revision = (await roadmap.snapshot(identity, projectId)).tasks[0]
        ?.revision;
      data.tasks[0] = { ...task, status };
      await writeFile(path, JSON.stringify(data));
      const before = await readFile(path, "utf8");
      const response = await app.inject({
        method: "POST",
        url: `${url}/tasks/${task.id}/approve`,
        payload: { revision },
      });
      expect(response.statusCode).toBe(409);
      expect(await readFile(path, "utf8")).toBe(before);
    },
  );

  it("keeps GitHub closure terminal and reflects it on the next read", async () => {
    const { app, roadmap, path, data } = await fixture();
    const revision = (await roadmap.snapshot(identity, projectId)).tasks[0]
      ?.revision;
    data.tasks[0] = {
      ...task,
      status: "completed",
      closed_at: "2026-10-15T01:00:00Z",
    } as typeof task;
    await writeFile(path, JSON.stringify(data));
    const response = await app.inject({
      method: "POST",
      url: `${url}/tasks/${task.id}/approve`,
      payload: { revision },
    });
    expect(response.statusCode).toBe(409);
    expect(body(await app.inject(url)).tasks[0]).toMatchObject({
      status: "completed",
      closed_at: "2026-10-15T01:00:00Z",
    });
  });

  it.each(["T-OTHER", "T-PROJECT", "T-LEGACY", "T-MISSING"])(
    "hides inaccessible task %s on approval",
    async (id) => {
      const { app } = await fixture();
      const response = await app.inject({
        method: "POST",
        url: `${url}/tasks/${id}/approve`,
        payload: { revision: "a".repeat(64) },
      });
      expect(response.statusCode).toBe(404);
    },
  );

  it.each(["", "/stream", `/tasks/${task.id}/approve`])(
    "denies anonymous access on %s",
    async (suffix) => {
      const { app, withTenant, snapshot, approve } = await fixture(false);
      const response = await app.inject({
        method: suffix.includes("approve") ? "POST" : "GET",
        url: `${url}${suffix}`,
        ...(suffix.includes("approve")
          ? { payload: { revision: "a".repeat(64) } }
          : {}),
        headers: { "x-tenant-id": tenantId },
      });
      expect(response.statusCode).toBe(401);
      expect(withTenant).not.toHaveBeenCalled();
      expect(snapshot).not.toHaveBeenCalled();
      expect(approve).not.toHaveBeenCalled();
    },
  );

  it("rejects missing projects and revoked actors before reading repository state", async () => {
    const { app, query, snapshot } = await fixture();
    query.mockImplementation((sql) =>
      Promise.resolve({
        rows: sql.includes("FROM actors") ? [{ id: actorId }] : [],
      }),
    );
    expect((await app.inject(url)).statusCode).toBe(404);
    expect(snapshot).not.toHaveBeenCalled();
    query.mockResolvedValue({ rows: [] });
    expect((await app.inject(url)).statusCode).toBe(401);
  });

  it.each([
    { revision: "invalid" },
    { revision: "a".repeat(64), tenant_id: otherId },
    { revision: "a".repeat(64), status: "completed" },
  ])("validates approval input before mutation: %j", async (payload) => {
    const { app, approve } = await fixture();
    expect(
      (
        await app.inject({
          method: "POST",
          url: `${url}/tasks/${task.id}/approve`,
          payload,
        })
      ).statusCode,
    ).toBe(422);
    expect(approve).not.toHaveBeenCalled();
  });

  it("returns sanitized failure without replacing a corrupt roadmap", async () => {
    const { app, path } = await fixture();
    await writeFile(path, "broken");
    const response = await app.inject(url);
    expect(response.statusCode).toBe(500);
    expect(response.body).not.toContain(path);
    expect(await readFile(path, "utf8")).toBe("broken");
  });
});

/** Observe Fastify's real streaming payload without opening a listening socket. */
function observeStream(app: FastifyInstance) {
  const queued: string[] = [];
  let deliver: ((value: string) => void) | undefined;
  app.addHook("onSend", (_request, _reply, payload, done) => {
    if (payload instanceof Readable)
      payload.on("data", (chunk: Buffer | string) => {
        const text = chunk.toString();
        if (deliver) {
          const send = deliver;
          deliver = undefined;
          send(text);
        } else queued.push(text);
      });
    done(null, payload);
  });
  return async () =>
    queued.shift() ??
    new Promise<string>((resolve) => {
      deliver = resolve;
    });
}

describe("Build SSE transport", () => {
  it("streams updates, revokes access during a connection and closes cleanly", async () => {
    const { app, query, data, path } = await fixture();
    const next = observeStream(app);
    const response = app.inject(`${url}/stream`);
    const initial = await next();
    expect(initial).toContain("event: snapshot");
    expect(initial).toContain('"status":"pending"');
    data.tasks[0] = { ...task, status: "in_progress" };
    data.current_task_id = task.id;
    await writeFile(path, JSON.stringify(data));
    const event = await next();
    const value: BuildSnapshot = BuildSnapshotSchema.parse(
      JSON.parse(event.split("\ndata: ")[1] ?? "null"),
    );
    expect(value).toMatchObject({
      current_task_id: task.id,
      tasks: [{ status: "in_progress" }],
    });
    query.mockResolvedValue({ rows: [] });
    expect(await next()).toBe("event: unavailable\ndata: {}\n\n");
    const result = await response;
    expect(result.statusCode).toBe(200);
    expect(result.headers["content-type"]).toContain("text/event-stream");
    expect(result.headers["cache-control"]).toContain("no-cache");
  });

  it("terminates connected clients on server shutdown", async () => {
    const { app } = await fixture();
    const next = observeStream(app);
    const response = app.inject(`${url}/stream`);
    await next();
    await app.close();
    expect((await response).body).toContain("event: snapshot");
  });
});
