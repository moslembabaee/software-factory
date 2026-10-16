import { describe, expect, it } from "vitest";
import { runCommand } from "../command.js";

// Synchronous fixture writes also work in restricted hosts where a child Node
// runtime cannot poll pipe-backed process.stdout/process.stderr.
const options = { timeoutMs: 3000, maxOutputBytes: 65536 };
const node = (code: string, overrides = {}) =>
  runCommand(process.execPath, ["-e", code], { ...options, ...overrides });

describe("bounded command transport", () => {
  it("captures stdout/stderr, supplies stdin and preserves nonzero exit codes", async () => {
    const result = await node(
      `
      const fs = require('node:fs');
      fs.writeSync(1, fs.readFileSync(0, 'utf8'));
      fs.writeSync(2, 'diagnostic');
      process.exitCode = 7;
    `,
      { input: "source; $(this is data)\n" },
    );
    expect(result).toEqual({
      stdout: "source; $(this is data)\n",
      stderr: "diagnostic",
      exitCode: 7,
      stopReason: null,
    });
  });

  it("does not inherit application credentials or Node options", async () => {
    const previous = process.env["SF_SANDBOX_TEST_SECRET"];
    process.env["SF_SANDBOX_TEST_SECRET"] = "private";
    try {
      const result = await node(
        "require('node:fs').writeSync(1, JSON.stringify(Object.keys(process.env)))",
      );
      const keys: unknown = JSON.parse(result.stdout);
      expect(keys).toEqual(["PATH"]);
    } finally {
      if (previous === undefined) delete process.env["SF_SANDBOX_TEST_SECRET"];
      else process.env["SF_SANDBOX_TEST_SECRET"] = previous;
    }
  });

  it("kills an infinite program on its wall-clock deadline", async () => {
    const result = await node("while (true) {}", { timeoutMs: 80 });
    expect(result.stopReason).toBe("timed_out");
    expect(result.exitCode).toBeNull();
  });

  it("bounds combined output and kills output floods", async () => {
    const result = await node(
      "const fs = require('node:fs'); while (true) { fs.writeSync(1, 'a'.repeat(10000)); fs.writeSync(2, 'b'.repeat(10000)); }",
      { maxOutputBytes: 101 },
    );
    expect(result.stopReason).toBe("output_limit");
    expect(
      Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr),
    ).toBe(101);
  });

  it("permits output exactly equal to the byte cap", async () => {
    const result = await node(
      "require('node:fs').writeSync(1, 'é'.repeat(32))",
      {
        maxOutputBytes: 64,
      },
    );
    expect(result).toMatchObject({
      stopReason: null,
      stdout: "é".repeat(32),
      exitCode: 0,
    });
  });

  it("handles caller cancellation while running", async () => {
    const controller = new AbortController();
    const task = node("setInterval(() => {}, 1000)", {
      signal: controller.signal,
    });
    const timer = setTimeout(() => {
      controller.abort();
    }, 80);
    try {
      expect((await task).stopReason).toBe("cancelled");
    } finally {
      clearTimeout(timer);
    }
  });

  it("handles pre-cancellation without spawning even a missing executable", async () => {
    const controller = new AbortController();
    controller.abort();
    expect(
      await runCommand("/nonexistent-sandbox-cli", [], {
        ...options,
        signal: controller.signal,
      }),
    ).toMatchObject({ stopReason: "cancelled" });
  });

  it("reports spawn errors and tolerates stdin closing before a large input is sent", async () => {
    await expect(
      runCommand("/nonexistent-sandbox-cli", [], options),
    ).rejects.toThrow();
    const result = await node("process.exit(0)", {
      input: "a".repeat(256 * 1024),
    });
    expect(result.exitCode).toBe(0);
    expect(result.stopReason).toBeNull();
  });

  it.each([
    { timeoutMs: 0 },
    { timeoutMs: NaN },
    { timeoutMs: 2147483648 },
    { maxOutputBytes: -1 },
    { maxOutputBytes: 1.5 },
  ])("rejects invalid transport limits %j", async (overrides) => {
    await expect(node("", overrides)).rejects.toThrow("resource limits");
  });
});
