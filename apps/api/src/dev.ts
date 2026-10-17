import { startServer } from "./server.js";
import type { FastifyRequest } from "fastify";

// Simple header-based identity for external dashboard access.
// The reverse proxy (Caddy) supplies x-tenant-id / x-actor-id headers for the
// agentos host; this resolves them without any external auth provider.
const headerAuthenticate = async (request: FastifyRequest) => {
  const tenantId = request.headers["x-tenant-id"];
  const actorId = request.headers["x-actor-id"];
  if (!tenantId || !actorId) return null;
  return {
    tenantId: String(tenantId),
    actorId: String(actorId),
  };
};

startServer(Number(process.env["PORT"] ?? 3003), {
  authenticate: headerAuthenticate,
}).catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
