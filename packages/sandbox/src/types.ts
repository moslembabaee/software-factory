import type { SandboxLimits } from "@software-factory/factory-core";

export {
  SandboxLimitsObjectSchema,
  SandboxLimitsSchema,
  SandboxProgramSchema,
  SandboxResultSchema,
  SandboxStatusSchema,
} from "@software-factory/factory-core";

export type {
  Execution,
  ExecutionSandbox,
  SandboxLimits,
  SandboxProgram,
  SandboxResult,
  SandboxStatus,
} from "@software-factory/factory-core";

export interface DockerSandboxOptions {
  /** Preloaded, operator-approved Node image, pinned to its content digest. */
  readonly image: string;
  readonly limits?: Partial<SandboxLimits>;
  readonly dockerExecutable?: string;
  /**
   * Operator attestation for this exact image, runtime and worker deployment.
   * Never accept this setting or a program's trust classification from an API body.
   * Without independent isolation/escape-suite evidence, only trusted tests run.
   */
  readonly untrustedIsolation?: {
    readonly runtime: string;
    readonly evidenceRef: string;
  };
}
