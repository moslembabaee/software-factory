import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  artifact,
  digest,
  event,
  fixture,
  headers,
  payloads,
  request,
  resourceId,
  sha,
  tenantId,
  actorId,
} from "./fixture.js";
import {
  baseline,
  must,
  normalize,
  operations,
  parameters,
  violations,
  type Schema,
} from "./openapi.js";

let context: Awaited<ReturnType<typeof fixture>>;
beforeAll(async () => {
  context = await fixture();
});
afterAll(async () => {
  await context.app.close();
});
beforeEach(() => {
  context.query.mockClear();
});

function expectError(
  response: {
    statusCode: number;
    json: () => unknown;
    headers: Record<string, unknown>;
  },
  status: number,
  code: string,
) {
  expect(response.statusCode).toBe(status);
  const body = response.json();
  expect(
    violations(must(baseline.components.schemas["ApiError"]), body),
  ).toBeNull();
  expect(body).toMatchObject({
    code,
    correlation_id: response.headers["x-request-id"],
    retryable: status === 503,
  });
}

describe("Phase 1 OpenAPI route inventory", () => {
  it("covers every implemented route and requires every Phase 1 operation to be registered", () => {
    // The health route is synchronous; onRoute observes the asynchronously registered API plugin.
    const implemented = [
      ...new Set(["GET /health", ...context.routes.keys()]),
    ].sort();
    expect(
      operations.map(({ method, url }) => `${method} ${url}`).sort(),
    ).toEqual(implemented);
    expect(
      new Set(operations.map(({ operation }) => operation.operationId)).size,
    ).toBe(operations.length);
    for (const endpoint of operations) {
      expect(
        context.app.hasRoute({
          method: endpoint.method,
          url: endpoint.url.replace("{id}", ":id"),
        }),
      ).toBe(true);
    }
  });

  it.each(operations)(
    "$method $path schemas match the baseline",
    async ({ method, url, operation }) => {
      if (url === "/health") await context.app.inject({ method: "GET", url });
      const schema = must(context.routes.get(`${method} ${url}`));
      expect(normalize(schema.body)).toEqual(
        normalize(operation.requestBody?.content["application/json"].schema),
      );
      expect(normalize(schema.params)).toEqual(
        normalize(parameters(operation, "path")),
      );
      expect(normalize(schema.headers)).toEqual(
        normalize(parameters(operation, "header")),
      );
      expect(normalize(schema.querystring)).toEqual(
        normalize(parameters(operation, "query")),
      );
      const responses = schema.response as Record<string, Schema>;
      for (const [status, documented] of Object.entries(operation.responses)) {
        if (status === "default") continue;
        expect(normalize(responses[status])).toEqual(
          normalize(
            documented.content?.["application/json"].schema ?? { type: "null" },
          ),
        );
      }
      for (const [status, actual] of Object.entries(responses)) {
        const documented =
          operation.responses[status] ?? operation.responses["default"];
        expect(documented, `Undocumented response ${status}`).toBeDefined();
        expect(normalize(actual)).toEqual(
          normalize(
            documented?.content?.["application/json"].schema ?? {
              type: "null",
            },
          ),
        );
      }
    },
  );
});

describe("Phase 1 HTTP contracts", () => {
  it.each(operations)(
    "$method $path returns the documented success shape",
    async (endpoint) => {
      const response = await context.app.inject(request(endpoint));
      const status = must(
        Object.keys(endpoint.operation.responses).find((value) =>
          /^2\d\d$/.test(value),
        ),
      );
      expect(response.statusCode, response.body).toBe(Number(status));
      expect(
        violations(
          { type: "string", format: "uuid" },
          response.headers["x-request-id"],
        ),
      ).toBeNull();
      const schema = must(endpoint.operation.responses[status]).content?.[
        "application/json"
      ].schema;
      if (!schema) {
        expect(response.body).toBe("");
        return;
      }
      expect(response.headers["content-type"]).toContain("application/json");
      const body: unknown = response.json();
      expect(violations(schema, body)).toBeNull();
      if (
        endpoint.path.includes("works") &&
        !endpoint.path.includes("executions")
      ) {
        expect(response.body).not.toContain("tenant_id");
        expect(response.body).not.toContain("created_by");
      }
      if (endpoint.operation.operationId === "listEvents") {
        expect(body).toEqual({
          items: [
            {
              event_id: resourceId,
              execution_id: resourceId,
              sequence: 0,
              type: event.type,
              occurred_at: event.occurred_at.toISOString(),
              payload: event.payload,
            },
          ],
          next_cursor: null,
        });
        expect(context.query.mock.calls.at(-1)?.[1]).toEqual([
          tenantId,
          resourceId,
          "-1",
          51,
        ]);
      }
      if (endpoint.operation.operationId === "listArtifacts")
        expect(body).toEqual({ items: [artifact] });
    },
  );

  const protectedEndpoints = operations.filter(
    ({ path }) => path !== "/health",
  );
  it("requires trusted authentication on every Phase 1 API operation", async () => {
    const unauthenticated = await fixture(false);
    try {
      for (const endpoint of protectedEndpoints)
        expectError(
          await unauthenticated.app.inject(request(endpoint)),
          401,
          "FORBIDDEN",
        );
      expect(unauthenticated.withTenant).not.toHaveBeenCalled();
    } finally {
      await unauthenticated.app.close();
    }
  });

  it.each(operations.filter(({ operation }) => operation.requestBody))(
    "$method $path rejects missing, mistyped and extra body fields before storage",
    async (endpoint) => {
      const schema = must(endpoint.operation.requestBody).content[
        "application/json"
      ].schema;
      const valid = must(payloads[endpoint.operation.operationId]);
      expect(violations(schema, valid)).toBeNull();
      expectError(
        await context.app.inject({
          method: endpoint.method,
          url: request(endpoint).url,
          headers,
        }),
        422,
        "VALIDATION_FAILED",
      );
      const invalid: unknown[] = [
        null,
        [],
        "wrong type",
        {},
        { ...valid, tenant_id: tenantId },
      ];
      for (const field of schema.required ?? []) {
        invalid.push(
          Object.fromEntries(
            Object.entries(valid).filter(([key]) => key !== field),
          ),
        );
      }
      for (const [field, property] of Object.entries(schema.properties ?? {})) {
        invalid.push({ ...valid, [field]: null });
        if (property.type === "string")
          invalid.push({ ...valid, [field]: 123 });
        if (property.type === "number" || property.type === "integer")
          invalid.push({ ...valid, [field]: "1" });
        if (property["format"] === "uuid")
          invalid.push({ ...valid, [field]: "not-a-uuid" });
        if (property["pattern"] === "\\S")
          invalid.push({ ...valid, [field]: " \t " });
        if (property.minLength) invalid.push({ ...valid, [field]: "" });
        if (property.maxLength)
          invalid.push({
            ...valid,
            [field]: "a".repeat(property.maxLength + 1),
          });
        if (property.minimum !== undefined)
          invalid.push({ ...valid, [field]: property.minimum - 1 });
        if (property.maximum !== undefined)
          invalid.push({ ...valid, [field]: property.maximum + 1 });
      }
      for (const payload of invalid) {
        expect(violations(schema, payload)).not.toBeNull();
        const response = await context.app.inject({
          ...request(endpoint),
          payload: JSON.stringify(payload),
          headers: { ...headers, "content-type": "application/json" },
        });
        expectError(response, 422, "VALIDATION_FAILED");
      }
      expect(context.query).not.toHaveBeenCalled();
    },
  );

  it.each(operations.filter(({ operation }) => parameters(operation, "path")))(
    "$method $path validates UUID path parameters before storage",
    async (endpoint) => {
      expectError(
        await context.app.inject({
          ...request(endpoint),
          url: endpoint.url.replace("{id}", "invalid"),
        }),
        422,
        "VALIDATION_FAILED",
      );
      expect(context.query).not.toHaveBeenCalled();
    },
  );

  it.each(
    operations.filter(({ operation }) => parameters(operation, "header")),
  )(
    "$method $path enforces idempotency header length and presence",
    async (endpoint) => {
      for (const value of [undefined, "", "a".repeat(7), "a".repeat(129)]) {
        expectError(
          await context.app.inject({
            ...request(endpoint),
            headers: value === undefined ? {} : { "idempotency-key": value },
          }),
          422,
          "VALIDATION_FAILED",
        );
      }
      expect(context.query).not.toHaveBeenCalled();
    },
  );

  it.each(operations.filter(({ operation }) => parameters(operation, "query")))(
    "$method $path enforces pagination ranges and integer types",
    async (endpoint) => {
      const query = must(parameters(endpoint.operation, "query"));
      for (const [field, property] of Object.entries(query.properties ?? {})) {
        if (property.type !== "integer") continue;
        for (const value of [
          String(must(property.minimum) - 1),
          String(must(property.maximum) + 1),
          "1.5",
          "invalid",
        ]) {
          expectError(
            await context.app.inject({
              ...request(endpoint),
              url: `${request(endpoint).url}?${field}=${value}`,
            }),
            422,
            "VALIDATION_FAILED",
          );
        }
      }
      if (query.additionalProperties === false) {
        expectError(
          await context.app.inject({
            ...request(endpoint),
            url: `${request(endpoint).url}?unknown=value`,
          }),
          422,
          "VALIDATION_FAILED",
        );
      }
      expect(context.query).not.toHaveBeenCalled();
    },
  );

  it("accepts exact objective, SHA, budget and idempotency boundaries without coercing JSON types", async () => {
    for (const [index, objective] of ["x", "x".repeat(20000)].entries()) {
      const response = await context.app.inject({
        method: "POST",
        url: "/api/v1/works",
        headers: {
          "idempotency-key": index === 0 ? "a".repeat(8) : "a".repeat(128),
        },
        payload: { project_id: resourceId, objective },
      });
      expect(response.statusCode).toBe(201);
    }
    for (const budget of [0, 100000]) {
      expect(
        (
          await context.app.inject({
            method: "POST",
            url: `/api/v1/works/${resourceId}/executions`,
            headers: { "idempotency-key": `budget-boundary-${String(budget)}` },
            payload: { base_sha: sha.toUpperCase(), budget_cap_usd: budget },
          })
        ).statusCode,
      ).toBe(201);
    }
    for (const base_sha of ["a".repeat(39), "a".repeat(41), "g".repeat(40)]) {
      expectError(
        await context.app.inject({
          method: "POST",
          url: `/api/v1/works/${resourceId}/executions`,
          headers,
          payload: { base_sha, budget_cap_usd: 1 },
        }),
        422,
        "VALIDATION_FAILED",
      );
    }
  });

  it("preserves execution inputs and tenant identity inside the scoped transaction", async () => {
    const endpoint = must(
      operations.find(
        ({ operation }) => operation.operationId === "createExecution",
      ),
    );
    expect(
      (
        await context.app.inject({
          ...request(endpoint),
          headers: { "idempotency-key": "execution-inputs-key" },
        })
      ).statusCode,
    ).toBe(201);
    expect(context.withTenant).toHaveBeenCalledWith(
      { tenantId, actorId },
      expect.any(Function),
    );
    const insert = context.query.mock.calls.find(([sql]) =>
      sql.startsWith("INSERT INTO executions"),
    );
    expect(insert?.[1]).toEqual([tenantId, resourceId, 10, resourceId]);
    const append = context.query.mock.calls.find(([sql]) =>
      sql.startsWith("WITH event AS"),
    );
    expect(JSON.parse(String(append?.[1]?.[3]))).toEqual(
      payloads["createExecution"],
    );
  });

  it("paginates nonempty events with a cursor and JSON integer sequences", async () => {
    context.query
      .mockResolvedValueOnce({ rows: [{ id: actorId }] })
      .mockResolvedValueOnce({ rows: [{ id: resourceId }] })
      .mockResolvedValueOnce({ rows: [event, { ...event, sequence: "1" }] });
    const response = await context.app.inject({
      method: "GET",
      url: `/api/v1/executions/${resourceId}/events?limit=1&cursor=0`,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      items: [{ sequence: 0, payload: event.payload }],
      next_cursor: "0",
    });
    expect(context.query.mock.calls.at(-1)?.[1]).toEqual([
      tenantId,
      resourceId,
      "0",
      2,
    ]);
  });

  it("returns the shared 404 envelope for missing or RLS-hidden resources", async () => {
    for (const endpoint of operations.filter(
      ({ method, path }) =>
        ["GET", "PATCH", "DELETE"].includes(method) && path.includes("{id}"),
    )) {
      context.query
        .mockResolvedValueOnce({ rows: [{ id: actorId }] })
        .mockResolvedValueOnce({ rows: [] });
      if (endpoint.method === "PATCH" && endpoint.path === "/works/{id}")
        context.query.mockResolvedValueOnce({ rows: [] });
      expectError(
        await context.app.inject(request(endpoint)),
        404,
        "NOT_FOUND",
      );
    }
  });

  it("replays idempotent creation and rejects a changed request with 409", async () => {
    const options = {
      method: "POST" as const,
      url: "/api/v1/works",
      headers: { "idempotency-key": "replay-contract-key" },
      payload: { project_id: resourceId, objective: "First" },
    };
    const first = await context.app.inject(options);
    const replay = await context.app.inject(options);
    expect(first.statusCode).toBe(201);
    expect(replay.statusCode).toBe(201);
    expect(replay.json()).toEqual(first.json());
    expect(
      context.query.mock.calls.filter(([sql]) =>
        sql.startsWith('INSERT INTO "works"'),
      ),
    ).toHaveLength(1);
    expectError(
      await context.app.inject({
        ...options,
        payload: { ...options.payload, objective: "Changed" },
      }),
      409,
      "CONFLICT",
    );
  });

  it.each([
    ["23505", 409, "CONFLICT"],
    ["23514", 422, "VALIDATION_FAILED"],
    ["42501", 403, "FORBIDDEN"],
    ["ECONNREFUSED", 503, "INTERNAL_ERROR"],
    ["unexpected", 500, "INTERNAL_ERROR"],
  ] as const)(
    "maps %s to a safe %s error contract",
    async (code, status, apiCode) => {
      context.query.mockRejectedValueOnce(
        Object.assign(new Error("private SQL credentials"), { code }),
      );
      const response = await context.app.inject({
        method: "GET",
        url: `/api/v1/works/${resourceId}`,
      });
      expectError(response, status, apiCode);
      expect(response.body).not.toContain("private");
    },
  );

  it("rejects malformed JSON with the shared error shape", async () => {
    expectError(
      await context.app.inject({
        method: "POST",
        url: "/api/v1/works",
        headers: { ...headers, "content-type": "application/json" },
        payload: "{",
      }),
      400,
      "VALIDATION_FAILED",
    );
    expect(context.query).not.toHaveBeenCalled();
  });

  it("never exposes a database bigint as a string or an imprecise JSON integer", async () => {
    context.query
      .mockResolvedValueOnce({ rows: [{ id: actorId }] })
      .mockResolvedValueOnce({
        rows: [
          {
            id: resourceId,
            project_id: resourceId,
            objective: "Build",
            state: "open",
            version: "9007199254740992",
          },
        ],
      });
    expectError(
      await context.app.inject({
        method: "GET",
        url: `/api/v1/works/${resourceId}`,
      }),
      500,
      "INTERNAL_ERROR",
    );
  });

  it("validates artifact hashes independently of the API serializer", () => {
    expect(
      violations(must(baseline.components.schemas["Artifact"]), {
        ...artifact,
        sha256: digest.toUpperCase(),
      }),
    ).not.toBeNull();
  });
});
