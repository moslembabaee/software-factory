import type { Execution } from "./primitives/execution.js";

export interface SandboxLimits {
  readonly timeoutMs: number;
  readonly memoryMb: number;
  readonly cpus: number;
  readonly pids: number;
  /** Size of each of the two writable, ephemeral tmpfs mounts. */
  readonly tmpfsMb: number;
  /** Combined stdout and stderr, measured in bytes before UTF-8 decoding. */
  readonly maxOutputBytes: number;
}

export interface SandboxProgram {
  /** JavaScript source, delivered over stdin, never a host shell command. */
  readonly code: string;
  /** Omission means untrusted. Only the trusted worker may set this field. */
  readonly trust?: "trusted" | "untrusted";
  /** Requests can lower the worker's limits, never raise them. */
  readonly limits?: Partial<SandboxLimits>;
}

export type SandboxStatus =
  | "succeeded"
  | "failed"
  | "timed_out"
  | "output_limit"
  | "out_of_memory"
  | "cancelled";

export interface SandboxResult {
  readonly tenantId: Execution["tenantId"];
  readonly executionId: Execution["id"];
  readonly sandboxRef: string;
  readonly status: SandboxStatus;
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly durationMs: number;
  /** A result is returned only after the container was removed. */
  readonly cleanupConfirmed: true;
}

export interface ExecutionSandbox {
  execute(
    execution: Execution,
    program: SandboxProgram,
    signal?: AbortSignal,
  ): Promise<SandboxResult>;
}
