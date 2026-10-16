import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import {
  ExecutionSchema,
  SandboxProgramSchema,
} from "@software-factory/factory-core";
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
import { SandboxError, SandboxCleanupError } from "./errors.js";
import { DEFAULT_SANDBOX_LIMITS, resolveLimits } from "./limits.js";
import type { DockerSandboxOptions } from "./types.js";

const CONTROL = Object.freeze({ timeoutMs: 5000, maxOutputBytes: 64 * 1024 });

function successful(
  result: CommandResult,
  operation: string,
  ref: string,
): string {
  if (result.exitCode !== 0 || result.stopReason !== null) {
    // Daemon stderr can contain deployment details; never return it as code logs.
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

/** One ephemeral container per Execution; never falls back to a host process. */
export class DockerSandbox implements ExecutionSandbox {
  private readonly image: string;
  private readonly executable: string;
  private readonly ceiling: SandboxLimits;
  private readonly isolation: DockerSandboxOptions["untrustedIsolation"];

  constructor(
    options: DockerSandboxOptions,
    private readonly command: CommandRunner = runCommand,
  ) {
    if (
      !/^[a-zA-Z0-9][a-zA-Z0-9._/:\-]*@sha256:[a-f0-9]{64}$/.test(options.image)
    ) {
      throw new TypeError("Sandbox image must be pinned to a sha256 digest");
    }
    const isolation = options.untrustedIsolation;
    if (
      isolation &&
      (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/.test(isolation.runtime) ||
        ["runc", "io.containerd.runc.v2"].includes(isolation.runtime) ||
        typeof isolation.evidenceRef !== "string" ||
        !isolation.evidenceRef.trim())
    )
      throw new TypeError(
        "Untrusted execution requires validated strong isolation evidence",
      );
    this.image = options.image;
    this.executable = options.dockerExecutable ?? "docker";
    this.ceiling = resolveLimits({
      ...DEFAULT_SANDBOX_LIMITS,
      ...options.limits,
    });
    this.isolation = isolation ? Object.freeze({ ...isolation }) : undefined;
  }

  async execute(
    execution: Execution,
    program: SandboxProgram,
    signal?: AbortSignal,
  ): Promise<SandboxResult> {
    const current = ExecutionSchema.parse(execution);
    if (current.state !== "running")
      throw new SandboxError("Execution must be running");
    const submitted = SandboxProgramSchema.parse(program);
    if (submitted.trust !== "trusted" && !this.isolation) {
      throw new SandboxError(
        "Untrusted execution disabled: independent strong-isolation validation required (SF-ADR-004)",
      );
    }
    if (Buffer.byteLength(submitted.code) > 256 * 1024) {
      throw new TypeError(
        "Sandbox source must be at most 256 KiB of JavaScript",
      );
    }
    const selected = resolveLimits(submitted.limits, this.ceiling);
    const name = `sf-sandbox-${randomUUID()}`;
    const ref = `docker:${name}`;
    const started = performance.now();
    const remaining = () =>
      Math.max(
        0,
        Math.floor(selected.timeoutMs - (performance.now() - started)),
      );
    if (signal?.aborted)
      throw new SandboxError("Sandbox cancelled before provisioning", ref);
    // Read-only preflight rejects image-declared writable volumes.
    const config = object(
      JSON.parse(
        successful(
          await this.command(
            this.executable,
            ["image", "inspect", "--format", "{{json .Config}}", this.image],
            {
              ...CONTROL,
              timeoutMs: Math.max(1, Math.min(CONTROL.timeoutMs, remaining())),
              ...(signal ? { signal } : {}),
            },
          ),
          "image inspection",
          ref,
        ),
      ) as unknown,
    );
    if (
      config["Volumes"] !== null &&
      config["Volumes"] !== undefined &&
      Object.keys(object(config["Volumes"])).length > 0
    ) {
      throw new SandboxError("Sandbox images cannot declare volumes", ref);
    }
    if (signal?.aborted || remaining() === 0) {
      throw new SandboxError(
        "Sandbox cancelled or timed out before provisioning",
        ref,
      );
    }
    let status: SandboxStatus;
    let exitCode: number | null = null;
    let stdout = "";
    let stderr = "";
    let creationSettled = false;
    try {
      // Do not abort create midway: cancellation is checked again before start.
      // A control timeout still requires cleanup and potentially reconciliation.
      const created = await this.command(
        this.executable,
        [
          "create",
          "--pull=never",
          "--name",
          name,
          "--interactive",
          "--init",
          "--network=none",
          "--ipc=private",
          "--cgroupns=private",
          // Docker's default PID namespace is private; --pid=private is invalid.
          "--pid=",
          "--user=65534:65534",
          "--cap-drop=ALL",
          "--security-opt=no-new-privileges:true",
          "--read-only",
          "--restart=no",
          "--log-driver=none",
          "--no-healthcheck",
          `--memory=${String(selected.memoryMb)}m`,
          `--memory-swap=${String(selected.memoryMb)}m`,
          `--cpus=${String(selected.cpus)}`,
          `--pids-limit=${String(selected.pids)}`,
          "--ulimit=nofile=128:128",
          "--ulimit=core=0:0",
          "--ulimit=fsize=16777216:16777216",
          "--tmpfs",
          `/tmp:rw,noexec,nosuid,nodev,size=${String(selected.tmpfsMb)}m,mode=1777`,
          "--tmpfs",
          `/workspace:rw,noexec,nosuid,nodev,size=${String(selected.tmpfsMb)}m,mode=1777`,
          "--workdir=/workspace",
          "--env=HOME=/tmp",
          "--env=TMPDIR=/tmp",
          ...(this.isolation ? [`--runtime=${this.isolation.runtime}`] : []),
          "--entrypoint=/usr/local/bin/node",
          this.image,
          "--input-type=commonjs",
          "-",
        ],
        {
          ...CONTROL,
          timeoutMs: Math.max(1, Math.min(CONTROL.timeoutMs, remaining())),
        },
      );
      creationSettled = created.stopReason === null;
      successful(created, "creation", ref);
      // Docker can report unsupported/discarded resource limits as warnings
      // while create still exits successfully. Never start in that case.
      if (created.stderr.trim()) {
        throw new SandboxError(
          "Sandbox creation reported warnings; resource enforcement required",
          ref,
        );
      }
      const available = remaining();
      const run: CommandResult = signal?.aborted
        ? { stdout: "", stderr: "", exitCode: null, stopReason: "cancelled" }
        : available === 0
          ? { stdout: "", stderr: "", exitCode: null, stopReason: "timed_out" }
          : await this.command(
              this.executable,
              ["start", "--attach", "--interactive", name],
              {
                input: submitted.code,
                timeoutMs: available,
                maxOutputBytes: selected.maxOutputBytes,
                ...(signal ? { signal } : {}),
              },
            );
      stdout = run.stdout;
      stderr = run.stderr;
      if (run.stopReason) {
        status = run.stopReason;
      } else {
        const state = object(
          JSON.parse(
            successful(
              await this.command(
                this.executable,
                ["inspect", "--format", "{{json .State}}", name],
                CONTROL,
              ),
              "state inspection",
              ref,
            ),
          ) as unknown,
        );
        if (
          state["Running"] !== false ||
          state["Status"] !== "exited" ||
          typeof state["ExitCode"] !== "number" ||
          !Number.isInteger(state["ExitCode"]) ||
          typeof state["OOMKilled"] !== "boolean" ||
          state["Error"] !== ""
        ) {
          throw new SandboxError(
            "Sandbox termination could not be confirmed",
            ref,
          );
        }
        exitCode = state["ExitCode"];
        status = state["OOMKilled"]
          ? "out_of_memory"
          : exitCode === 0
            ? "succeeded"
            : "failed";
      }
    } catch (cause) {
      if (cause instanceof SandboxError) throw cause;
      throw new SandboxError("Sandbox operation failed", ref, { cause });
    } finally {
      // rm -f kills all container processes. Killing the attached CLI does not.
      // Always remove by generated name, even after a failed create. Cleanup has
      // its own deadline and never inherits the caller's cancelled signal.
      try {
        const removed = await this.command(
          this.executable,
          ["rm", "--force", "--volumes", name],
          CONTROL,
        );
        if (removed.exitCode !== 0 || removed.stopReason !== null) {
          // If create timed out, 'not found' can race a delayed daemon allocation.
          if (
            !creationSettled ||
            removed.stopReason !== null ||
            removed.stderr.trim() !==
              `Error response from daemon: No such container: ${name}`
          ) {
            throw new Error("Container removal was not confirmed");
          }
        }
      } catch (cause) {
        throw new SandboxCleanupError(
          "Sandbox cleanup uncertain; reconciliation required",
          ref,
          { cause },
        );
      }
    }
    return {
      tenantId: current.tenantId,
      executionId: current.id,
      sandboxRef: ref,
      status,
      exitCode,
      stdout,
      stderr,
      durationMs: Math.ceil(performance.now() - started),
      cleanupConfirmed: true,
    };
  }
}
