/**
 * @software-factory/api entry point.
 *
 * Phase 1 API and authentication integration points. The standalone HTTP
 * server is started via `src/dev.ts`.
 */
export { buildApp, startServer } from "./server.js";
export type { AppOptions } from "./server.js";
export type { Authenticate } from "./resources.js";

/** Placeholder entry point for the API scaffold. */
export function noop(): void {}

export { FileBuildRoadmap } from "./build-roadmap.js";
export type { BuildRoadmap } from "./build-roadmap.js";
