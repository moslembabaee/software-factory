import Fastify, { type FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { Ajv } from "ajv";
import addFormats from "ajv-formats";
import { createApplicationPool, PostgresDatabase, type TenantDatabase } from "@software-factory/storage";
import { ApiError } from "./errors.js";
import { registerResources, type Authenticate } from "./resources.js";
import { responseSchema } from "./schemas.js";

export interface AppOptions {
  database?: TenantDatabase;
  /** Must verify credentials and resolve tenant/actor on the server. */
  authenticate?: Authenticate;
}

export function buildApp(options: AppOptions = {}): FastifyInstance {
  const app = Fastify({ genReqId: () => randomUUID(), bodyLimit: 1_048_576 });
  const createValidator = (coerceTypes: boolean) => {
    const validator = new Ajv({ coerceTypes, useDefaults: true, removeAdditional: false, allErrors: false });
    addFormats(validator);
    return validator;
  };
  const validators = { body: createValidator(false), query: createValidator(true) };
  app.setValidatorCompiler(({ schema, httpPart }) => (httpPart === "querystring" ? validators.query : validators.body).compile(schema as object));
  const pool = options.database ? undefined : createApplicationPool();
  const database = options.database ?? (pool ? new PostgresDatabase(pool) : undefined);
  if (!database) throw new Error("Database configuration required");
  if (pool) {
    pool.on("error", (error) => { app.log.error(error, "Idle database connection failed"); });
    app.addHook("onClose", async () => pool.end());
  }
  app.addHook("onRequest", async (request, reply) => {
    reply.header("x-request-id", request.id);
  });
  app.setErrorHandler((error: unknown, request, reply) => {
    let status = 500;
    let code = "INTERNAL_ERROR";
    let message = "Internal server error";
    if (error instanceof ApiError) {
      status = error.statusCode; code = error.code; message = error.message;
    } else if (error instanceof z.ZodError) {
      status = 422; code = "VALIDATION_FAILED"; message = "Invalid request schema";
    } else if (error && typeof error === "object" && "validation" in error) {
      status = 422; code = "VALIDATION_FAILED"; message = "Invalid request schema";
    } else if (error && typeof error === "object" && "code" in error) {
      if (error.code === "23505" || error.code === "23503") {
        status = 409; code = "CONFLICT"; message = "Resource conflicts with existing data";
      } else if (error.code === "23514" || error.code === "22P02") {
        status = 422; code = "VALIDATION_FAILED"; message = "Invalid request data";
      } else if (error.code === "42501") {
        status = 403; code = "FORBIDDEN"; message = "Operation forbidden";
      } else if (["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "57P01", "53300", "57014"].includes(String(error.code)) || String(error.code).startsWith("08")) {
        status = 503; code = "INTERNAL_ERROR"; message = "Database unavailable";
      }
    }
    if (status === 500 && error && typeof error === "object" && "statusCode" in error && typeof error.statusCode === "number" && error.statusCode >= 400 && error.statusCode < 500) {
      status = error.statusCode; code = "VALIDATION_FAILED"; message = "Invalid request";
    }
    if (status >= 500) request.log.error(error);
    return reply.code(status).send({ code, message, correlation_id: request.id, retryable: status === 503, safe_action: status === 503 ? "Retry the request later with the same idempotency key" : status >= 500 ? "Contact support with the correlation ID" : "Check the request and your access before retrying" });
  });

  app.get("/health", { schema: responseSchema(200, { type: "object", additionalProperties: false, required: ["status", "service", "phase", "request_id"], properties: { status: { const: "ok" }, service: { const: "software-factory-api" }, phase: { const: 1 }, request_id: { type: "string", format: "uuid" } } }) }, (_request, reply) => {
    return reply.send({
      status: "ok",
      service: "software-factory-api",
      phase: 1,
      request_id: _request.id,
    });
  });

  app.setNotFoundHandler((request, reply) => reply.code(404).send({
    code: "NOT_FOUND", message: "Resource not found", correlation_id: request.id, retryable: false, safe_action: "Check the resource URL and your access",
  }));

  app.register((api, _options, done) => {
    registerResources(api, database, options.authenticate ?? (() => null));
    done();
  }, { prefix: "/api/v1" });

  return app;
}

export async function startServer(port = Number(process.env["PORT"] ?? 3000), options: AppOptions = {}): Promise<FastifyInstance> {
  const app = buildApp(options);
  try {
    await app.listen({ port, host: "0.0.0.0" });
  } catch (error) {
    await app.close();
    throw error;
  }
  return app;
}
