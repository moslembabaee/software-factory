import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { ExecutionSchema } from "@software-factory/factory-core";
import type {
  Execution,
  ExecutionSandbox,
  SandboxLimits,
  SandboxProgram,
  SandboxResult,
  SandboxStatus,
} from "@software-factory/factory-core";
import { runCommand } from "./command.js";
import type { CommandResult, CommandRunner } from "./command.js";

export const DEFAULT_SANDBOX_LIMITS: SandboxLimits = Object.freeze({
  timeoutMs: 30_000,
  memoryMb: 128,
  cpus: 1,
  pids: 64,
  tmpfsMb: 16,
  maxOutputBytes: 1024 * 1024,
});

export interface DockerSandboxOptions {
  /** Preloaded, operator-approved Node image, pinned to its content digest. */
  readonly image: string;
  readonly limits?: Partial<SandboxLimits>;
  readonly dockerExecutable?: string;
  /**
   * Operator attestation, never accepted from a submitted program/API body.
   * Must identify independent isolation/escape-suite evidence for this exact
   * image, runtime and worker deployment. No attestation means trusted tests only.
   */
  readonly untrustedIsolation?: {
    readonly runtime: string;
    readonly evidenceRef: string;
  };
}

export class SandboxError extends Error {
  override readonly name: string = "SandboxError";
  constructor(
    message: string,
    readonly sandboxRef: string | null = null,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

/** Cleanup uncertainty must go to reconciliation, never successful queue ack. */
export class SandboxCleanupError extends SandboxError {
  override readonly name = "SandboxCleanupError";
}

function limits(overrides: Partial<SandboxLimits>, ceiling: SandboxLimits): SandboxLimits {
  const result = { ...ceiling, ...overrides };
  for (const key of Object.keys(ceiling) as (keyof SandboxLimits)[]) {
    const value = result[key];
    if (
      !Number.isFinite(value) || value <= 0 || value > ceiling[key] ||
      (key !== "cpus" && !Number.isSafeInteger(value)) ||
      (key === "memoryMb" && value < 32)
    ) throw new TypeError(`Invalid sandbox limit: ${key}`);
  }
  return Object.freeze(result);
}

const MAXIMUM_LIMITS: SandboxLimits = {
  timeoutMs: 3_600_000, memoryMb: 4096, cpus: 4,
  pids: 512, tmpfsMb: 256, maxOutputBytes: 16 * 1024 * 1024,
};
const CONTROL = { timeoutMs: 5000, maxOutputBytes: 64 * 1024 };

function successful(result: CommandResult, operation: string, ref: string): string {
  if (result.exitCode !== 0 || result.stopReason !== null) {
    // Daemon stderr can contain deployment details; do not turn it into code logs.
    throw new SandboxError(`Sandbox ${operation} failed`, ref);
  }
  return result.stdout;
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Invalid Docker inspection response");
  }
  return value as Record<string, unknown>;
}

export class DockerSandbox implements ExecutionSandbox {
  private readonly image: string;
  private readonly executable: string;
  private readonly ceiling: SandboxLimits;
  private readonly isolation: DockerSandboxOptions["untrustedIsolation"];

  constructor(options: DockerSandboxOptions, private readonly command: CommandRunner = runCommand) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._/:\-]*@sha256:[a-f0-9]{64}$/.test(options.image)) {
      throw new TypeError("Sandbox image must be pinned to a sha256 digest");
    }
    const isolation = options.untrustedIsolation;
    if (isolation && (
      !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/.test(isolation.runtime) ||
      ["runc", "io.containerd.runc.v2"].includes(isolation.runtime) ||
      !isolation.evidenceRef.trim()
    )) throw new TypeError("Untrusted execution requires validated strong isolation evidence");
    this.image = options.image;
    this.executable = options.dockerExecutable ?? "docker";
    this.ceiling = limits({ ...DEFAULT_SANDBOX_LIMITS, ...options.limits }, MAXIMUM_LIMITS);
    this.isolation = isolation ? Object.freeze({ ...isolation }) : undefined;
  }

  async execute(execution: Execution, program: SandboxProgram, signal?: AbortSignal): Promise<SandboxResult> {
    const current = ExecutionSchema.parse(execution);
    if (current.state !== "running") throw new SandboxError("Execution must be running");
    if (program.trust !== undefined && !["trusted", "untrusted"].includes(program.trust)) {
      throw new TypeError("Invalid sandbox trust classification");
    }
    if (program.trust !== "trusted" && !this.isolation) {
      throw new SandboxError("Untrusted execution disabled: independent strong-isolation validation required (SF-ADR-004)");
    }
    if (typeof program.code !== "string" || Buffer.byteLength(program.code) > 256 * 1024) {
      throw new TypeError("Sandbox source must be at most 256 KiB of JavaScript");
    }
    const source = program.code;
    const selected = limits(program.limits ?? {}, this.ceiling);
    const name = `sf-sandbox-${randomUUID()}`;
    const ref = `docker:${name}`;
    const started = performance.now();
    // Preflight is read-only and cannot create any resources.
    if (signal?.aborted) throw new SandboxError("Sandbox cancelled before provisioning", ref);
    const config = object(JSON.parse(successful(await this.command(this.executable,
      ["image", "inspect", "--format", "{{json .Config}}", this.image], CONTROL), "image inspection", ref)) as unknown);
    if (config["Volumes"] !== null && config["Volumes"] !== undefined && Object.keys(object(config["Volumes"])).length > 0) {
      throw new SandboxError("Sandbox images cannot declare volumes", ref);
    }
    let status: SandboxStatus;
    let exitCode: number | null = null;
    let stdout = "";
    let stderr = "";
    try {
      successful(await this.command(this.executable, [
        "create", "--pull=never", "--name", name, "--interactive", "--init",
        "--network=none", "--ipc=private", "--pid=private", "--cgroupns=private",
        "--user=65534:65534", "--cap-drop=ALL", "--security-opt=no-new-privileges:true",
        "--read-only", "--restart=no", "--log-driver=none",
        `--memory=${selected.memoryMb}m`, `--memory-swap=${selected.memoryMb}m`,
        `--cpus=${selected.cpus}`, `--pids-limit=${selected.pids}`,
        "--ulimit=nofile=128:128", "--ulimit=core=0:0",
        "--ulimit=fsize=16777216:16777216",
        "--tmpfs", `/tmp:rw,noexec,nosuid,nodev,size=${selected.tmpfsMb}m,mode=1777`,
        "--tmpfs", `/workspace:rw,noexec,nosuid,nodev,size=${selected.tmpfsMb}m,mode=1777`,
        "--workdir=/workspace", "--env=HOME=/tmp", "--env=TMPDIR=/tmp",
        ...(this.isolation ? [`--runtime=${this.isolation.runtime}`] : []),
        "--entrypoint=/usr/local/bin/node", this.image, "--input-type=commonjs", "-",
      ], CONTROL), "creation", ref);
      const remaining = selected.timeoutMs - (performance.now() - started);
      const run = remaining <= 0
        ? { stdout: "", stderr: "", exitCode: null, stopReason: "timed_out" as const }
        : await this.command(this.executable, ["start", "--attach", "--interactive", name], {
          input: source, timeoutMs: Math.max(1, Math.floor(remaining)),
          maxOutputBytes: selected.maxOutputBytes, ...(signal ? { signal } : {}),
        });
      stdout = run.stdout;
      stderr = run.stderr;
      if (run.stopReason) {
        status = run.stopReason;
      } else {
        const state = object(JSON.parse(successful(await this.command(this.executable,
          ["inspect", "--format", "{{json .State}}", name], CONTROL), "state inspection", ref)) as unknown);
        if (state["Running"] !== false || state["Status"] !== "exited" ||
          typeof state["ExitCode"] !== "number" || !Number.isInteger(state["ExitCode"]) ||
          typeof state["OOMKilled"] !== "boolean" || state["Error"] !== "") {
          throw new SandboxError("Sandbox termination could not be confirmed", ref);
        }
        exitCode = state["ExitCode"];
        status = state["OOMKilled"] ? "out_of_memory" : exitCode === 0 ? "succeeded" : "failed";
      }
    } finally {
      // Always remove by generated name, even if create failed after allocation.
      // Do not propagate the aborted signal to cleanup. rm -f kills ALL processes
      // in the container, unlike killing only the attached Docker CLI client.
      try {
        const removed = await this.command(this.executable, ["rm", "--force", "--volumes", name], CONTROL);
        if (removed.exitCode !== 0 || removed.stopReason !== null) {
          // A failed create may legitimately leave no container at all.
          if (removed.stopReason !== null || removed.stderr.trim() !== `Error response from daemon: No such container: ${name}`) {
            throw new Error("Container removal was not confirmed");
          }
        }
      } catch (cause) {
        throw new SandboxCleanupError("Sandbox cleanup uncertain; reconciliation required", ref, { cause });
      }
    }
    return {
      tenantId: current.tenantId, executionId: current.id, sandboxRef: ref,
      status, exitCode, stdout, stderr,
      durationMs: Math.ceil(performance.now() - started), cleanupConfirmed: true,
    };
  }
}
