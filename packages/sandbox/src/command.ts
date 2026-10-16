import { spawn } from "node:child_process";

export interface CommandOptions {
  readonly input?: string;
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
  readonly signal?: AbortSignal;
}

export interface CommandResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;
  readonly stopReason: "timed_out" | "output_limit" | "cancelled" | null;
}

export type CommandRunner = (
  executable: string,
  args: readonly string[],
  options: CommandOptions,
) => Promise<CommandResult>;

/** Bounded CLI transport. Killing this client alone does NOT kill a container. */
export const runCommand: CommandRunner = (executable, args, options) => {
  return new Promise((resolve, reject) => {
    if (
      !Number.isSafeInteger(options.timeoutMs) ||
      options.timeoutMs < 1 ||
      options.timeoutMs > 2_147_483_647 ||
      !Number.isSafeInteger(options.maxOutputBytes) ||
      options.maxOutputBytes < 1
    ) {
      reject(new TypeError("Invalid command resource limits"));
      return;
    }
    if (options.signal?.aborted) {
      resolve({
        stdout: "",
        stderr: "",
        exitCode: null,
        stopReason: "cancelled",
      });
      return;
    }
    const child = spawn(executable, [...args], {
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      // In particular, do not inherit NODE_OPTIONS or application credentials.
      env: { PATH: process.env["PATH"] ?? "/usr/local/bin:/usr/bin:/bin" },
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let bytes = 0;
    let stopReason: CommandResult["stopReason"] = null;
    const stop = (reason: NonNullable<CommandResult["stopReason"]>) => {
      if (stopReason !== null) return;
      stopReason = reason;
      child.kill("SIGKILL");
      // Descendants can inherit pipes. Closing our ends ensures transport
      // shutdown cannot wait forever before the container cleanup can run.
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
    };
    const capture = (chunks: Buffer[], chunk: Buffer) => {
      const available = Math.max(0, options.maxOutputBytes - bytes);
      if (available > 0) chunks.push(chunk.subarray(0, available));
      bytes += Math.min(available, chunk.length);
      if (chunk.length > available) stop("output_limit");
    };
    child.stdout.on("data", (chunk: Buffer) => {
      capture(stdout, chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      capture(stderr, chunk);
    });
    const timer = setTimeout(() => {
      stop("timed_out");
    }, options.timeoutMs);
    const abort = () => {
      stop("cancelled");
    };
    options.signal?.addEventListener("abort", abort, { once: true });
    // Cover an abort between the initial check and registering the listener.
    if (options.signal?.aborted) abort();
    const dispose = () => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
    };
    // Early exits can close stdin before the entire source has been delivered.
    child.stdin.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code !== "EPIPE" && error.code !== "ERR_STREAM_DESTROYED") {
        dispose();
        stop("cancelled");
        reject(error);
      }
    });
    child.on("error", (error) => {
      dispose();
      reject(error);
    });
    child.on("close", (exitCode) => {
      dispose();
      resolve({
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        exitCode,
        stopReason,
      });
    });
    child.stdin.end(options.input);
  });
};
