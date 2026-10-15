import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

export interface Schema {
  [keyword: string]: unknown;
  type?: string | string[];
  properties?: Record<string, Schema>;
  required?: string[];
  items?: Schema;
  additionalProperties?: boolean | Schema;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
}
interface Parameter {
  name: string;
  in: "path" | "query" | "header";
  required?: boolean;
  schema: Schema;
}
interface Response {
  content?: { "application/json": { schema: Schema } };
}
export interface Operation {
  operationId: string;
  "x-phase"?: number;
  "x-query-additional-properties"?: boolean;
  parameters?: Parameter[];
  requestBody?: {
    required: boolean;
    content: { "application/json": { schema: Schema } };
  };
  responses: Record<string, Response>;
}
interface OpenApi {
  paths: Record<string, Record<string, Operation>>;
  components: { schemas: Record<string, Schema> };
}
const require = createRequire(import.meta.url);
const yaml = require("js-yaml") as { load: (source: string) => unknown };
const source = yaml.load(
  readFileSync(
    new URL("../../../docs/46_OPENAPI_BASELINE.yaml", import.meta.url),
    "utf8",
  ),
);

/** Resolve local OpenAPI references independently of the implementation's schemas. */
function resolve(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(resolve);
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (typeof record["$ref"] === "string") {
      const reference = record["$ref"];
      if (!reference.startsWith("#/"))
        throw new Error(`Unsupported reference: ${reference}`);
      let target: unknown = source;
      for (const part of reference.slice(2).split("/")) {
        if (!target || typeof target !== "object")
          throw new Error(`Unresolved reference: ${reference}`);
        target = (target as Record<string, unknown>)[
          part.replace(/~1/g, "/").replace(/~0/g, "~")
        ];
      }
      if (!target) throw new Error(`Unresolved reference: ${reference}`);
      return resolve(target);
    }
    return Object.fromEntries(
      Object.entries(record).map(([key, child]) => [key, resolve(child)]),
    );
  }
  return value;
}
export const baseline = resolve(source) as OpenApi;
export const operations = Object.entries(baseline.paths).flatMap(
  ([path, methods]) =>
    Object.entries(methods)
      .filter(([, operation]) => [1, 3, 4].includes(operation["x-phase"] ?? 0))
      .map(([method, operation]) => ({
        path,
        method: method.toUpperCase() as "GET" | "POST" | "PATCH" | "DELETE",
        operation,
        url: path === "/health" ? path : `/api/v1${path}`,
      })),
);
export type Endpoint = (typeof operations)[number];

export function parameters(
  operation: Operation,
  location: Parameter["in"],
): Schema | undefined {
  const entries =
    operation.parameters?.filter((parameter) => parameter.in === location) ??
    [];
  if (!entries.length) return undefined;
  const required = entries
    .filter((parameter) => parameter.required)
    .map((parameter) =>
      location === "header" ? parameter.name.toLowerCase() : parameter.name,
    );
  return {
    type: "object",
    ...(required.length ? { required } : {}),
    ...(location === "query" &&
    operation["x-query-additional-properties"] === false
      ? { additionalProperties: false }
      : {}),
    properties: Object.fromEntries(
      entries.map((parameter) => [
        location === "header" ? parameter.name.toLowerCase() : parameter.name,
        parameter.schema,
      ]),
    ),
  };
}

/** Omitted additionalProperties means true in both JSON Schema dialects. */
export function normalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .filter(
          ([key, child]) =>
            key !== "$schema" &&
            !(key === "additionalProperties" && child === true),
        )
        .map(([key, child]) => [
          key,
          normalize(
            ["type", "required", "enum"].includes(key) && Array.isArray(child)
              ? Array.from(child as unknown[]).sort()
              : child,
          ),
        ]),
    );
  return value;
}
const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats(ajv);
export function violations(schema: Schema, value: unknown): unknown {
  const validate = ajv.compile(schema);
  return validate(value) ? null : validate.errors;
}

export function must<T>(value: T | undefined): T {
  if (value === undefined)
    throw new Error("Missing contract fixture or schema");
  return value;
}
