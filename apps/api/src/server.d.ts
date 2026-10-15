import { type FastifyInstance } from "fastify";
/**
 * Builds the API app with its route registration.
 * Phase 0: health endpoint + empty route placeholders.
 */
export declare function buildApp(): FastifyInstance;
export declare function startServer(port?: number): Promise<FastifyInstance>;
