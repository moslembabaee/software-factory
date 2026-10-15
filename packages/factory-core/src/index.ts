/**
 * @software-factory/factory-core
 *
 * The six Factory domain primitives (docs/06_DOMAIN_AND_STORAGE_v2.md,
 * docs/31_INTEGRATED_SYSTEM_ARCHITECTURE.md): Work, Actor, Execution, Event,
 * Reference, Relation. Domain must not import runtime, API, or UI code
 * (docs/13 dependency rule).
 */
export type { Work, WorkState } from "./work.js";
export type { Actor, ActorKind } from "./actor.js";
export type { Execution, ExecutionState } from "./execution.js";
export type { Event } from "./event.js";
export type { Reference } from "./reference.js";
export type { Relation } from "./relation.js";