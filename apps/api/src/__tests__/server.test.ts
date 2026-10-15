import type { FastifyInstance } from "fastify";
import { afterEach, describe, it, expect } from "vitest";
import { buildApp } from "../server.js";

const apps: FastifyInstance[] = [];
function app() {
  const instance = buildApp();
  apps.push(instance);
  return instance;
}
afterEach(async () => { await Promise.all(apps.splice(0).map((instance) => instance.close())); });

describe("API server", () => {
  it("builds and returns a Fastify instance", () => {
    const instance = app();
    expect(instance).toBeDefined();
    expect(typeof instance.listen).toBe("function");
  });

  it("/health returns Phase 1 liveness without needing a database", async () => {
    const response = await app().inject({ method: "GET", url: "/health" });
    expect(response.statusCode).toBe(200);
    const body: unknown = JSON.parse(response.body);
    expect(body).toMatchObject({
      status: "ok",
      service: "software-factory-api",
      phase: 1,
    });
  });

  it("returns 404 for unknown routes", async () => {
    const response = await app().inject({
      method: "GET",
      url: "/nonexistent",
    });
    expect(response.statusCode).toBe(404);
  });
});
