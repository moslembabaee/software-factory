import { describe, it, expect } from "vitest";
import { buildApp } from "../server.js";
describe("API server", () => {
    it("builds and returns a Fastify instance", () => {
        const app = buildApp();
        expect(app).toBeDefined();
        expect(typeof app.listen).toBe("function");
    });
    it("/health returns ok with phase 0", async () => {
        const app = buildApp();
        const response = await app.inject({ method: "GET", url: "/health" });
        expect(response.statusCode).toBe(200);
        const body = JSON.parse(response.body);
        expect(body).toMatchObject({
            status: "ok",
            service: "software-factory-api",
            phase: 0,
        });
    });
    it("returns 404 for unknown routes", async () => {
        const app = buildApp();
        const response = await app.inject({
            method: "GET",
            url: "/nonexistent",
        });
        expect(response.statusCode).toBe(404);
    });
});
