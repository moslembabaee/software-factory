import type { SandboxLimits } from "./types.js";

export const DEFAULT_SANDBOX_LIMITS: SandboxLimits = Object.freeze({
  timeoutMs: 30_000,
  memoryMb: 128,
  cpus: 1,
  pids: 64,
  tmpfsMb: 16,
  maxOutputBytes: 1024 * 1024,
});

export const MAXIMUM_SANDBOX_LIMITS: SandboxLimits = Object.freeze({
  timeoutMs: 3_600_000,
  memoryMb: 4096,
  cpus: 4,
  pids: 512,
  tmpfsMb: 256,
  maxOutputBytes: 16 * 1024 * 1024,
});

export function resolveLimits(
  overrides:
    | { readonly [K in keyof SandboxLimits]?: SandboxLimits[K] | undefined }
    | undefined,
  ceiling: SandboxLimits = MAXIMUM_SANDBOX_LIMITS,
): SandboxLimits {
  const result = { ...ceiling };
  for (const key of Object.keys(ceiling) as (keyof SandboxLimits)[]) {
    const value =
      overrides && Object.hasOwn(overrides, key)
        ? overrides[key]
        : ceiling[key];
    if (
      typeof value !== "number" ||
      !Number.isFinite(value) ||
      value <= 0 ||
      value > ceiling[key] ||
      (key !== "cpus" && !Number.isSafeInteger(value)) ||
      (key === "memoryMb" && value < 32)
    ) {
      throw new TypeError(`Invalid sandbox limit: ${key}`);
    }
    result[key] = value;
  }
  return Object.freeze(result);
}
