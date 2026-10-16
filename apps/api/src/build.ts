import { Readable } from "node:stream";
import { setTimeout } from "node:timers/promises";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  BuildSnapshotSchema,
  BuildApprovalSchema,
  BuildBudgetUpdateSchema,
  type BuildBudgetUpdate,
} from "@software-factory/factory-core";
import type { Scoped } from "./core.js";
import type { BuildRoadmap } from "./build-roadmap.js";
import { ApiError } from "./errors.js";
import { idParams, errorResponses, responseSchema } from "./schemas.js";

function jsonSchema(schema: z.ZodType): object {
  const result = z.toJSONSchema(schema);
  delete result.$schema;
  return result;
}

export function registerBuildRoutes(
  app: FastifyInstance,
  scoped: Scoped,
  roadmap: BuildRoadmap,
): void {
  const streams = new Set<AbortController>();
  let closing = false;
  app.addHook("preClose", (done) => {
    closing = true;
    for (const stream of streams) stream.abort();
    done();
  });
  const requireProject = (request: FastifyRequest) =>
    scoped(request, async (client, identity) => {
      const { id } = request.params as { id: string };
      const project = await client.query(
        "SELECT id FROM projects WHERE tenant_id = $1 AND id = $2",
        [identity.tenantId, id],
      );
      if (!project.rows.length)
        throw new ApiError(404, "NOT_FOUND", "Resource not found");
      return identity;
    });
  const snapshot = async (request: FastifyRequest) => {
    const identity = await requireProject(request);
    return roadmap.snapshot(identity, (request.params as { id: string }).id);
  };
  const taskParams = {
    ...idParams,
    required: ["id", "taskId"],
    properties: {
      ...idParams.properties,
      taskId: {
        type: "string",
        minLength: 1,
        maxLength: 128,
        pattern: "^[A-Za-z0-9_-]+$",
      },
    },
  };

  app.get(
    "/projects/:id/build",
    {
      schema: responseSchema(200, jsonSchema(BuildSnapshotSchema), {
        params: idParams,
      }),
    },
    snapshot,
  );
  app.post<{
    Params: { id: string; taskId: string };
    Body: { revision: string };
  }>(
    "/projects/:id/build/tasks/:taskId/approve",
    {
      schema: responseSchema(200, jsonSchema(BuildSnapshotSchema), {
        params: taskParams,
        body: jsonSchema(BuildApprovalSchema),
      }),
    },
    async (request) => {
      const identity = await requireProject(request);
      return roadmap.approve(
        identity,
        request.params.id,
        request.params.taskId,
        request.body.revision,
      );
    },
  );

  app.patch<{
    Params: { id: string; taskId: string };
    Body: BuildBudgetUpdate;
  }>(
    "/projects/:id/build/tasks/:taskId/budget",
    {
      schema: responseSchema(200, jsonSchema(BuildSnapshotSchema), {
        params: taskParams,
        body: jsonSchema(BuildBudgetUpdateSchema),
      }),
    },
    async (request) => {
      const identity = await requireProject(request);
      return roadmap.setBudget(
        identity,
        request.params.id,
        request.params.taskId,
        request.body,
      );
    },
  );

  // Send rolling snapshots so a reconnect replaces state without duplicate logs.
  // Each tick rechecks actor/project access in a short RLS transaction.
  app.get(
    "/projects/:id/build/stream",
    { schema: { params: idParams, response: errorResponses } },
    async (request, reply) => {
      const initial = await snapshot(request);
      if (closing)
        throw new ApiError(503, "INTERNAL_ERROR", "Build stream shutting down");
      const controller = new AbortController();
      streams.add(controller);
      const stopped = () => controller.signal.aborted;
      const stop = () => {
        controller.abort();
        streams.delete(controller);
      };
      reply.raw.once("close", stop);
      async function* events() {
        try {
          yield `event: snapshot\ndata: ${JSON.stringify(initial)}\n\n`;
          while (!stopped()) {
            await setTimeout(1000, undefined, { signal: controller.signal });
            if (stopped()) break;
            const next = await snapshot(request);
            if (!stopped())
              yield `event: snapshot\ndata: ${JSON.stringify(next)}\n\n`;
          }
        } catch {
          if (!stopped()) yield "event: unavailable\ndata: {}\n\n";
        } finally {
          stop();
        }
      }
      return reply
        .headers({
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache, no-transform",
          "x-accel-buffering": "no",
        })
        .send(Readable.from(events()));
    },
  );
}
