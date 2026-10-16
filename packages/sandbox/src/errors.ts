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
