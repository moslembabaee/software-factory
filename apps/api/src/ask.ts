import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  AskAcceptanceSchema,
  AskPlanSchema,
  IntakeSchema,
  proposeTasks,
} from "@software-factory/factory-core";
import { ApiError } from "./errors.js";
import type { Scoped } from "./core.js";
import type { AskRoadmap } from "./ask-roadmap.js";
import { idempotencyHeaders, idParams, responseSchema } from "./schemas.js";

function jsonSchema(schema: z.ZodType): object {
  const json = z.toJSONSchema(schema);
  delete json.$schema;
  return json;
}

export function registerAskRoutes(
  app: FastifyInstance,
  scoped: Scoped,
  roadmap: AskRoadmap,
): void {
  const requireProject = async (request: Parameters<Scoped>[0]) =>
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

  app.post<{ Params: { id: string } }>(
    "/projects/:id/ask",
    {
      schema: responseSchema(200, jsonSchema(AskPlanSchema), {
        params: idParams,
        body: jsonSchema(IntakeSchema),
      }),
    },
    async (request) => {
      const plan = proposeTasks(request.body);
      await requireProject(request);
      return plan;
    },
  );

  app.post<{
    Params: { id: string };
    Body: { description: string; accepted: true };
  }>(
    "/projects/:id/ask/tasks",
    {
      schema: responseSchema(201, jsonSchema(AskAcceptanceSchema), {
        params: idParams,
        headers: idempotencyHeaders,
        body: jsonSchema(IntakeSchema.extend({ accepted: z.literal(true) })),
      }),
    },
    async (request, reply) => {
      const plan = proposeTasks({ description: request.body.description });
      const identity = await requireProject(request);
      const tasks = await roadmap.accept(
        plan,
        identity,
        request.params.id,
        String(request.headers["idempotency-key"]),
      );
      return reply.code(201).send({ tasks, request_id: request.id });
    },
  );
}
