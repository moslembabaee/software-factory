import Fastify, {} from "fastify";
/**
 * Builds the API app with its route registration.
 * Phase 0: health endpoint + empty route placeholders.
 */
export function buildApp() {
    const app = Fastify();
    app.get("/health", async () => ({
        status: "ok",
        service: "software-factory-api",
        phase: 0,
    }));
    return app;
}
export async function startServer(port = 3000) {
    const app = buildApp();
    await app.listen({ port, host: "0.0.0.0" });
    return app;
}
