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
  DiagnosticCategorySchema,
  FailureDiagnosticSchema,
  FailureAnalysisSchema,
  ConfidenceLevelSchema,
  DiffFileStatusSchema,
  CorrelatedFileSchema,
  LocalizedRemediationTaskSchema,
  correlateFailureWithDiff,
  generateRemediationTaskId,
  synthesizeRemediationTask,
} from "./failure-analysis.js";
export type {
  DiagnosticCategory,
  FailureDiagnostic,
  FailureAnalysis,
  ConfidenceLevel,
  DiffFileStatus,
  CorrelatedFile,
  LocalizedRemediationTask,
  DiffFileInfo,
} from "./failure-analysis.js";
export {
  ExecutionSchema,
  ExecutionStateSchema,
} from "./primitives/execution.js";
export type { Execution, ExecutionState } from "./primitives/execution.js";
export {
  SandboxStatusSchema,
  SandboxLimitsObjectSchema,
  SandboxLimitsSchema,
  SandboxProgramSchema,
  SandboxResultSchema,
} from "./sandbox.js";
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
export {
  IntakeSchema,
  TaskProposalSchema,
  AskPlanSchema,
  PendingTaskSchema,
  AskAcceptanceSchema,
  proposeTasks,
} from "./intake.js";
export type {
  TaskProposal,
  AskPlan,
  PendingTask,
  AskAcceptance,
} from "./intake.js";
export {
  BuildStatusSchema,
  BuildTaskSchema,
  BuildLogSchema,
  BuildSnapshotSchema,
  BuildApprovalSchema,
  BuildBudgetUpdateSchema,
  TaskTokensSchema,
  TaskBudgetSchema,
  TaskTelemetrySchema,
  BuildMetricsBudgetSchema,
  BuildMetricsSchema,
  canApproveTask,
} from "./build.js";
export type {
  BuildTask,
  BuildLog,
  BuildSnapshot,
  BuildBudgetUpdate,
  TaskTokens,
  TaskBudget,
  TaskTelemetry,
  BuildMetrics,
  BuildMetricsBudget,
} from "./build.js";
export {
  PullRequestStatusSchema,
  MergeStateStatusSchema,
  MergeQueueStatusSchema,
  ConflictDetailsSchema,
  RebaseResultSchema,
  MergeQueueEntrySchema,
  CiStatusSchema,
  PullRequestMetadataSchema,
  PullRequestSchema,
  RegressionContextSchema,
  BugfixTaskSchema,
  ReviewRoleSchema,
  ReviewDecisionSchema,
  ReviewFindingSchema,
  ReviewEvaluationSchema,
  ConsensusPolicySchema,
  ConsensusReviewGateResultSchema,
  generateBranchName,
  formatPullRequestBody,
  canAutoMerge,
  parseCiErrorLogs,
  generateBugfixTask,
  evaluateSecurityReview,
  evaluateLintReview,
  dispatchParallelReviews,
  evaluateConsensusReviewGate,
  detectConflicts,
  needsRebase,
  createMergeQueueEntry,
  prioritizeMergeQueue,
  evaluateRebaseOutcome,
  formatConflictComment,
} from "./pr-lifecycle.js";
export type {
  PullRequestStatus,
  MergeStateStatus,
  MergeQueueStatus,
  ConflictDetails,
  RebaseResult,
  MergeQueueEntry,
  CiStatus,
  PullRequestMetadata,
  PullRequest,
  RegressionContext,
  BugfixTask,
  ReviewRole,
  ReviewDecision,
  ReviewFinding,
  ReviewEvaluation,
  ConsensusPolicy,
  ConsensusReviewGateResult,
  DiffFileInput,
  ReviewInput,
} from "./pr-lifecycle.js";
export {
  WorktreeStatusSchema,
  WorktreeInfoSchema,
  WorktreeConflictDetailsSchema,
  WorktreeReconciliationResultSchema,
  ConcurrentExecutionConfigSchema,
  ConcurrentExecutionStatusSchema,
  generateWorktreePath,
  generateWorktreeBranch,
  parseWorktreeConflictFiles,
  detectFileOverlap,
  canExecuteConcurrently,
  evaluateReconciliationOutcome,
  formatWorktreeCleanupLog,
} from "./worktree.js";
export type {
  WorktreeStatus,
  WorktreeInfo,
  WorktreeConflictDetails,
  WorktreeReconciliationResult,
  ConcurrentExecutionConfig,
  ConcurrentExecutionStatus,
} from "./worktree.js";

export {
  StreamEventTypeSchema,
  TaskTransitionEventSchema,
  AgentLogEventSchema,
  RoadmapSyncEventSchema,
  TelemetryStreamEventSchema,
  ConnectionStreamEventSchema,
  StreamEventSchema,
  formatSseEvent,
  parseSseChunk,
  encodeWebSocketFrame,
  decodeWebSocketFrame,
  createEventFilter,
} from "./streaming-bus.js";
export type {
  StreamEventType,
  TaskTransitionEvent,
  AgentLogEvent,
  RoadmapSyncEvent,
  TelemetryStreamEvent,
  ConnectionStreamEvent,
  StreamEvent,
} from "./streaming-bus.js";

export {
  DEFAULT_AGENT_RATES,
  KNOWN_FAILURE_MODES,
  extractTokenUsage,
  calculateTokenCost,
  calculateBudgetCap,
  computeTaskTelemetry,
  recordAttemptTelemetry,
  computeActiveAttempt,
  aggregateBuildMetrics,
  ValueError,
} from "./telemetry.js";
export type {
  AgentRate,
  KnownFailureMode,
  AttemptTelemetryInput,
  TaskTelemetryInput,
} from "./telemetry.js";


