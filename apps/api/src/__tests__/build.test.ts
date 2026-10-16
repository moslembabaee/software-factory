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
  it("returns task and agent telemetry without including another tenant's spend or attempt output", async () => {
    const { app, data, path } = await fixture();
    const attempt = {
      agent: "codex",
      model: "reported-model",
      failure: "timeout",
      tokens: { prompt: 100, completion: 20, total: 120 },
      cost_usd: 0.001,
      duration_seconds: 2,
      agent_duration_seconds: 1.5,
      verification_duration_seconds: 0.5,
      prompt_cost_usd: 0.0006,
      completion_cost_usd: 0.0004,
      log_tail: "Provider secret",
    };
    const telemetry = {
      tokens: attempt.tokens,
      cost_usd: 0.001,
      duration_seconds: 2,
      failure_modes: { timeout: 1 },
    };
    await writeFile(
      path,
      JSON.stringify({
        ...data,
        tasks: [
          { ...task, telemetry, attempts: [attempt], budget_cap_usd: 0.01 },
          {
            ...task,
            id: "T-OTHER",
            tenant_id: otherId,
            telemetry: { ...telemetry, cost_usd: 99 },
            attempts: [{ ...attempt, model: "private-model" }],
          },
        ],
      }),
    );
    const response = await app.inject(url);
    expect(response.statusCode, response.body).toBe(200);
    expect(body(response)).toMatchObject({
      tasks: [
        {
          telemetry: {
            tokens: { total: 120 },
            cost_usd: 0.001,
            attempt_count: 1,
          },
        },
      ],
      metrics: {
        prompt_tokens: 100,
        completion_tokens: 20,
        prompt_cost_usd: 0.0006,
        completion_cost_usd: 0.0004,
        failed_attempts: 1,
        successful_attempts: 0,
        pending_attempts: 0,
        success_rate: 0,
        failure_rate: 1,
        avg_agent_latency_seconds: 1.5,
        avg_verification_latency_seconds: 0.5,
        p95_latency_seconds: 1.5,
        total_tasks_count: 1,
        models: [
          { agent: "codex", model: "reported-model", total_cost_usd: 0.001 },
        ],
        total_cost_usd: 0.001,
        total_tokens: 120,
        avg_latency_seconds: 2,
        retry_rate: 0,
        failure_modes: { timeout: 1 },
        agents: [
          {
            agent: "codex",
            attempt_count: 1,
            failed_attempts: 1,
            total_tokens: 120,
          },
        ],
      },
    });
    expect(response.body).not.toMatch(
      /Provider secret|private-model|log_tail|T-OTHER/,
    );
  });

  it("updates budgets atomically, rejects stale decisions and can remove a cap", async () => {
    const { app, roadmap, path } = await fixture();
    const revision = (await roadmap.snapshot(identity, projectId)).tasks[0]
      ?.revision;
    const request = {
      method: "PATCH" as const,
      url: `${url}/tasks/${task.id}/budget`,
      payload: { revision, budget_cap_usd: 0 },
    };
    const response = await app.inject(request);
    expect(response.statusCode, response.body).toBe(200);
    expect(body(response).tasks[0]).toMatchObject({
      budget_cap_usd: 0,
      telemetry: { budget: { cap_usd: 0, exceeded: true } },
    });
    expect((await app.inject(request)).statusCode).toBe(409);
    const removed = await app.inject({
      ...request,
      payload: {
        revision: body(response).tasks[0]?.revision,
        budget_cap_usd: null,
      },
    });
    expect(removed.statusCode).toBe(200);
    expect(body(removed).tasks[0]?.telemetry?.budget.cap_usd).toBeNull();
    expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({
      custom: "preserved",
      tasks: [{ budget_cap_usd: null }, {}, {}, {}],
    });
  });

  it.each([-1, "1", true, null])(
    "validates budget mutation input: %j",
    async (value) => {
      const { app, roadmap } = await fixture();
      const setBudget = vi.spyOn(roadmap, "setBudget");
      const payload =
        value === null
          ? { budget_cap_usd: 5 }
          : { revision: "a".repeat(64), budget_cap_usd: value };
      expect(
        (
          await app.inject({
            method: "PATCH",
            url: `${url}/tasks/${task.id}/budget`,
            payload,
          })
        ).statusCode,
      ).toBe(422);
      expect(setBudget).not.toHaveBeenCalled();
    },
  );

  it("requires authentication and project access for budget changes", async () => {
    const { app, roadmap } = await fixture(false);
    const setBudget = vi.spyOn(roadmap, "setBudget");
    const request = {
      method: "PATCH" as const,
      url: `${url}/tasks/${task.id}/budget`,
      payload: { revision: "a".repeat(64), budget_cap_usd: 5 },
    };
    expect((await app.inject(request)).statusCode).toBe(401);
    expect(setBudget).not.toHaveBeenCalled();
    const allowed = await fixture();
    const budget = vi.spyOn(allowed.roadmap, "setBudget");
    allowed.query.mockImplementation((sql) =>
      Promise.resolve({
        rows: sql.includes("FROM projects") ? [] : [{ id: actorId }],
      }),
    );
    expect((await allowed.app.inject(request)).statusCode).toBe(404);
    expect(budget).not.toHaveBeenCalled();
  });

  it("hides foreign tasks and refuses budget changes to closed tasks", async () => {
    const { app, roadmap, data, path } = await fixture();
    for (const id of ["T-OTHER", "T-PROJECT", "T-LEGACY"]) {
      expect(
        (
          await app.inject({
            method: "PATCH",
            url: `${url}/tasks/${id}/budget`,
            payload: { revision: "a".repeat(64), budget_cap_usd: 5 },
          })
        ).statusCode,
      ).toBe(404);
    }
    await writeFile(
      path,
      JSON.stringify({
        ...data,
        tasks: [{ ...task, closed_at: "2026-10-16T00:00:00Z" }],
      }),
    );
    const revision = (await roadmap.snapshot(identity, projectId)).tasks[0]
      ?.revision;
    expect(
      (
        await app.inject({
          method: "PATCH",
          url: `${url}/tasks/${task.id}/budget`,
          payload: { revision, budget_cap_usd: 5 },
        })
      ).statusCode,
    ).toBe(409);
  });

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

  it.each([
    "in_progress",
    "ready_for_verification",
    "verified",
    "completed",
    "cancelled",
  ])("rejects approval after task changed to %s", async (status) => {
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
  });

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
    const running = {
      ...task,
      status: "in_progress",
      active_attempt: {
        agent: "codex",
        phase: "agent",
        started_at: new Date().toISOString(),
      },
    };
    data.tasks[0] = running;
    data.current_task_id = task.id;
    await writeFile(path, JSON.stringify(data));
    const event = await next();
    const value: BuildSnapshot = BuildSnapshotSchema.parse(
      JSON.parse(event.split("\ndata: ")[1] ?? "null"),
    );
    expect(value).toMatchObject({
      current_task_id: task.id,
      tasks: [
        {
          status: "in_progress",
          active_attempt: { agent: "codex", phase: "agent" },
        },
      ],
      metrics: {
        total_tokens: 0,
        active_tasks_count: 1,
        active_agent_count: 1,
        task_lifecycle_counts: { in_progress: 1 },
      },
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
