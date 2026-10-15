/**
 * @software-factory/api entry point.
 *
 * Phase 0 scaffold — exports the server module for consumers such as the
 * migration runner, health checker, and integration tests. The standalone
 * HTTP server is started via `src/server.ts`.
 */
export { buildApp, startServer } from "./server.js";
/** Placeholder entry point for the API scaffold. */
export declare function noop(): void;
