import type { FastifySchema } from "fastify";

// Phase 1 wire contracts. Contract tests compare these with the normative YAML.
export const uuid = { type: "string", format: "uuid" };
export const idParams = { type: "object", required: ["id"], properties: { id: uuid } };
export const idempotencyHeaders = {
  type: "object", required: ["idempotency-key"],
  properties: { "idempotency-key": { type: "string", minLength: 8, maxLength: 128 } },
};
export const apiErrorSchema = {
  type: "object", additionalProperties: false,
  required: ["code", "message", "correlation_id", "retryable", "safe_action"],
  properties: {
    code: { type: "string", enum: ["VALIDATION_FAILED", "NOT_FOUND", "FORBIDDEN", "CONFLICT", "STALE_REVISION", "PREVIEW_EXPIRED", "PREVIEW_NOT_READY", "REDACTION_BLOCKED", "ACCEPTANCE_MISMATCH", "BUDGET_LIMIT", "UNKNOWN_EXTERNAL_EFFECT", "RATE_LIMITED", "INTERNAL_ERROR"] },
    message: { type: "string" }, correlation_id: uuid, retryable: { type: "boolean" },
    safe_action: { type: "string" }, details: { type: "object", additionalProperties: true },
  },
};
export const errorResponses = Object.fromEntries(
  [400, 401, 403, 404, 409, 413, 415, 422, 429, 500, 503].map((status) => [status, apiErrorSchema]),
);
export const workSchema = {
  type: "object", required: ["id", "project_id", "objective", "state", "version", "request_id"],
  properties: { id: uuid, project_id: uuid, objective: { type: "string" }, state: { type: "string" }, version: { type: "integer" }, request_id: uuid },
};
export const executionSchema = {
  type: "object", required: ["id", "work_id", "state", "version", "request_id"],
  properties: {
    id: uuid, work_id: uuid,
    state: { type: "string", enum: ["queued", "running", "awaiting_approval", "verifying", "needs_reconciliation", "cancelling", "completed", "failed", "cancelled", "budget_exhausted"] },
    version: { type: "integer" }, request_id: uuid,
  },
};
export const eventSchema = {
  type: "object", required: ["event_id", "execution_id", "sequence", "type", "occurred_at", "payload"],
  properties: {
    event_id: uuid, execution_id: uuid, sequence: { type: "integer", minimum: 0 },
    type: { type: "string" }, occurred_at: { type: "string", format: "date-time" },
    payload: { type: "object", additionalProperties: true },
  },
};
export const artifactSchema = {
  type: "object", required: ["id", "sha256", "media_type"],
  properties: { id: uuid, sha256: { type: "string", pattern: "^[a-f0-9]{64}$" }, media_type: { type: "string" } },
};
export const createWorkBody = {
  type: "object", additionalProperties: false, required: ["project_id", "objective"],
  properties: { project_id: uuid, objective: { type: "string", minLength: 1, maxLength: 20000 } },
};
export const createExecutionBody = {
  type: "object", additionalProperties: false, required: ["base_sha", "budget_cap_usd"],
  properties: {
    base_sha: { type: "string", pattern: "^[a-fA-F0-9]{40}$" },
    budget_cap_usd: { type: "number", minimum: 0, maximum: 100000 }, parent_execution_id: uuid,
  },
};
export const eventQuery = {
  type: "object", properties: {
    cursor: { type: "string" }, limit: { type: "integer", minimum: 1, maximum: 200, default: 50 },
  },
};
export const eventsSchema = {
  type: "object", required: ["items"], properties: {
    items: { type: "array", items: eventSchema }, next_cursor: { type: ["string", "null"] },
  },
};
export const artifactsSchema = {
  type: "object", required: ["items"], properties: { items: { type: "array", items: artifactSchema } },
};
export function responseSchema(status: number, body: object, request: FastifySchema = {}): FastifySchema {
  return { ...request, response: { ...errorResponses, [status]: body } };
}

/** PostgreSQL int8 values must be JSON integers without losing precision. */
export function wireInteger(value: unknown): number {
  if (typeof value !== "string" && typeof value !== "number") throw new Error("Invalid database integer");
  const number = Number(value);
  if (!Number.isSafeInteger(number)) throw new Error("Database integer exceeds JSON precision");
  return number;
}
export function wireResource(name: string, row: Record<string, unknown>, requestId: string): Record<string, unknown> {
  if (name === "works") return { id: row["id"], project_id: row["project_id"], objective: row["objective"], state: row["state"], version: wireInteger(row["version"]), request_id: requestId };
  if (name === "executions") return { id: row["id"], work_id: row["work_id"], state: row["state"], version: wireInteger(row["version"]), request_id: requestId };
  return { ...row, request_id: requestId };
}
