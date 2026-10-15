/**
 * @software-factory/factory-core
 *
 * The six Factory domain primitives (docs/06_DOMAIN_AND_STORAGE_v2.md,
 * docs/31_INTEGRATED_SYSTEM_ARCHITECTURE.md): Work, Actor, Execution, Event,
 * Reference, Relation. Domain must not import runtime, API, or UI code
 * (docs/13 dependency rule).
 */
export type { DomainPrimitive } from "./domain-primitive.js";
export type { ValueObject } from "./value-object.js";

export { WorkSchema, WorkStateSchema } from "./primitives/work.js";
export type { Work, WorkState } from "./primitives/work.js";
export type {
  WorkQueue,
  QueueIdentity,
  QueueItem,
  QueueStatus,
  QueueOutcome,
  EnqueueWork,
  DequeueWork,
  AcknowledgeWork,
} from "./work-queue.js";
export { ActorSchema, ActorKindSchema } from "./primitives/actor.js";
export type { Actor, ActorKind } from "./primitives/actor.js";
export {
  ExecutionSchema,
  ExecutionStateSchema,
} from "./primitives/execution.js";
export type { Execution, ExecutionState } from "./primitives/execution.js";
export type {
  ExecutionSandbox,
  SandboxLimits,
  SandboxProgram,
  SandboxResult,
  SandboxStatus,
} from "./sandbox.js";
export { EventSchema, EventTypeSchema } from "./primitives/event.js";
export type { Event, EventType } from "./primitives/event.js";
export { ReferenceSchema } from "./primitives/reference.js";
export type { Reference } from "./primitives/reference.js";
export { RelationSchema } from "./primitives/relation.js";
export type { Relation } from "./primitives/relation.js";
