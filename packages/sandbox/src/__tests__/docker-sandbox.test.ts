import { performance } from "node:perf_hooks";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SandboxResultSchema } from "@software-factory/factory-core";
import type { SandboxProgram } from "@software-factory/factory-core";
import { DockerSandbox, SandboxCleanupError, SandboxError } from "../index.js";
import type { CommandResult, CommandRunner } from "../command.js";
import { execution, image } from "./fixtures.js";

const ok = (stdout = ""): CommandResult => ({
  stdout,
  stderr: "",
  exitCode: 0,
  stopReason: null,
});
const exited = {
  Running: false,
  Status: "exited",
  ExitCode: 0,
  OOMKilled: false,
  Error: "",
};
const program = {
  code: "console.log('hello'); console.error('warning');",
  trust: "trusted" as const,
};

function fixture() {
  const command = vi
    .fn<CommandRunner>()
    .mockImplementation((_executable, args) => {
      if (args[0] === "image") return Promise.resolve(ok('{"Volumes":null}'));
      if (args[0] === "inspect")
        return Promise.resolve(ok(JSON.stringify(exited)));
      if (args[0] === "start")
        return Promise.resolve({ ...ok("hello\n"), stderr: "warning\n" });
      return Promise.resolve(ok("container-id"));
    });
  return { command, sandbox: new DockerSandbox({ image }, command) };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Docker sandbox", () => {
  it("creates a bounded container, streams source over stdin, captures both streams and removes it", async () => {
    const { command, sandbox } = fixture();
    const current = execution();
    const result = await sandbox.execute(current, program);
    expect(SandboxResultSchema.safeParse(result).success).toBe(true);
    expect(result).toMatchObject({
      executionId: current.id,
      tenantId: current.tenantId,
      status: "succeeded",
      exitCode: 0,
      stdout: "hello\n",
      stderr: "warning\n",
      cleanupConfirmed: true,
    });
    const name = result.sandboxRef.slice("docker:".length);
    expect(name).toMatch(/^sf-sandbox-[a-f0-9-]{36}$/);
    const create = command.mock.calls[1]?.[1] ?? [];
    expect(create).toEqual(
      expect.arrayContaining([
        "create",
        "--pull=never",
        "--name",
        name,
        "--init",
        "--network=none",
        "--ipc=private",
        "--pid=",
        "--cgroupns=private",
        "--user=65534:65534",
        "--cap-drop=ALL",
        "--security-opt=no-new-privileges:true",
        "--read-only",
        "--restart=no",
        "--log-driver=none",
        "--no-healthcheck",
        "--memory=128m",
        "--memory-swap=128m",
        "--cpus=1",
        "--pids-limit=64",
        "--ulimit=core=0:0",
        "--ulimit=nofile=128:128",
        "--ulimit=fsize=16777216:16777216",
        "/tmp:rw,noexec,nosuid,nodev,size=16m,mode=1777",
        "/workspace:rw,noexec,nosuid,nodev,size=16m,mode=1777",
        "--workdir=/workspace",
        "--entrypoint=/usr/local/bin/node",
        image,
        "--input-type=commonjs",
        "-",
      ]),
    );
    expect(create).not.toContain("--pid=private");
    expect(create).not.toContain("--privileged");
    expect(create).not.toContain("--volume");
    expect(create).not.toContain("--mount");
    expect(create).not.toContain("--tty");
    expect(
      command.mock.calls.every(([, args]) => !args.includes(program.code)),
    ).toBe(true);
    expect(command.mock.calls[2]).toEqual([
      "docker",
      ["start", "--attach", "--interactive", name],
      expect.objectContaining({
        input: program.code,

        maxOutputBytes: 1024 * 1024,
      }),
    ]);
    expect(command.mock.calls.at(-1)).toEqual([
      "docker",
      ["rm", "--force", "--volumes", name],
      { timeoutMs: 5000, maxOutputBytes: 65536 },
    ]);
  });

  it("uses unique containers for concurrent attempts", async () => {
    const { sandbox } = fixture();
    const current = execution();
    const [a, b] = await Promise.all([
      sandbox.execute(current, program),
      sandbox.execute(current, program),
    ]);
    expect(a.sandboxRef).not.toBe(b.sandboxRef);
  });

  it.each([undefined, "untrusted"] as const)(
    "fails closed for trust=%s without independent isolation evidence",
    async (trust) => {
      const { command, sandbox } = fixture();
      await expect(
        sandbox.execute(execution(), { code: "", ...(trust ? { trust } : {}) }),
      ).rejects.toThrow("Untrusted execution disabled");
      expect(command).not.toHaveBeenCalled();
    },
  );

  it("uses only the operator-configured validated runtime for untrusted code", async () => {
    const { command } = fixture();
    const sandbox = new DockerSandbox(
      {
        image,
        untrustedIsolation: {
          runtime: "runsc",
          evidenceRef: "isolation-suite:sha256:test",
        },
      },
      command,
    );
    const result = await sandbox.execute(execution(), {
      code: "console.log('ok')",
    });
    expect(result.status).toBe("succeeded");
    expect(command.mock.calls[1]?.[1]).toContain("--runtime=runsc");
  });

  it.each([
    { runtime: "runc", evidenceRef: "suite" },
    { runtime: "io.containerd.runc.v2", evidenceRef: "suite" },
    { runtime: "runsc", evidenceRef: " " },
    { runtime: "--privileged", evidenceRef: "suite" },
  ])(
    "rejects invalid untrusted isolation configuration %j",
    (untrustedIsolation) => {
      expect(() => new DockerSandbox({ image, untrustedIsolation })).toThrow(
        "strong isolation evidence",
      );
    },
  );

  it.each(["node:22", "--privileged", `node@sha256:${"a".repeat(63)}`])(
    "rejects mutable or malformed image %s",
    (badImage) => {
      expect(() => new DockerSandbox({ image: badImage })).toThrow("pinned");
    },
  );

  it.each([
    { timeoutMs: 0 },
    { timeoutMs: 30_001 },
    { cpus: 2 },
    { memoryMb: 31 },
    { memoryMb: 129 },
    { pids: 65 },
    { pids: 1.5 },
    { tmpfsMb: 17 },
    { maxOutputBytes: 1048577 },
    { cpus: NaN },
    { timeoutMs: Infinity },
  ])(
    "rejects invalid or raised per-program limits %j before provisioning",
    async (limits) => {
      const { sandbox, command } = fixture();
      await expect(
        sandbox.execute(execution(), { ...program, limits }),
      ).rejects.toThrow();
      expect(command).not.toHaveBeenCalled();
    },
  );

  it("honors reduced operator and program limits without mutating configuration", async () => {
    const { command } = fixture();
    const limits = {
      timeoutMs: 2000,
      memoryMb: 64,
      cpus: 0.5,
      pids: 32,
      tmpfsMb: 4,
      maxOutputBytes: 1000,
    };
    const sandbox = new DockerSandbox({ image, limits }, command);
    limits.memoryMb = 1024;
    await sandbox.execute(execution(), {
      ...program,
      limits: { pids: 16, maxOutputBytes: 500 },
    });
    expect(command.mock.calls[1]?.[1]).toEqual(
      expect.arrayContaining(["--memory=64m", "--cpus=0.5", "--pids-limit=16"]),
    );
    expect(command.mock.calls[2]?.[2]).toMatchObject({ maxOutputBytes: 500 });
    await expect(
      sandbox.execute(execution(), { ...program, limits: { pids: 33 } }),
    ).rejects.toThrow("pids");
  });

  it.each([{ memoryMb: 4097 }, { timeoutMs: 3_600_001 }, { cpus: 5 }])(
    "enforces absolute worker ceilings %j",
    (limits) => {
      expect(() => new DockerSandbox({ image, limits })).toThrow("limit");
    },
  );

  it("rejects oversized UTF-8 source, invalid trust and inactive executions before Docker", async () => {
    const { sandbox, command } = fixture();
    await expect(
      sandbox.execute(execution(), { ...program, code: "é".repeat(131073) }),
    ).rejects.toThrow("256 KiB");
    await expect(
      sandbox.execute(execution(), {
        ...program,
        trust: "user",
      } as unknown as SandboxProgram),
    ).rejects.toThrow();
    await expect(
      sandbox.execute({ ...execution(), state: "queued" }, program),
    ).rejects.toThrow("must be running");
    expect(command).not.toHaveBeenCalled();
  });

  it("rejects image-declared volumes before allocating a container", async () => {
    const { sandbox, command } = fixture();
    command.mockResolvedValueOnce(ok('{"Volumes":{"/data":{}}}'));
    await expect(sandbox.execute(execution(), program)).rejects.toThrow(
      "declare volumes",
    );
    expect(command).toHaveBeenCalledOnce();
  });

  it.each([
    [0, false, "succeeded"],
    [7, false, "failed"],
    [137, true, "out_of_memory"],
  ] as const)(
    "classifies inspected exit=%s oom=%s as %s",
    async (ExitCode, OOMKilled, status) => {
      const { sandbox, command } = fixture();
      command.mockImplementation((_bin, args) =>
        Promise.resolve(
          args[0] === "image"
            ? ok("{}")
            : args[0] === "inspect"
              ? ok(JSON.stringify({ ...exited, ExitCode, OOMKilled }))
              : ok(),
        ),
      );
      expect(await sandbox.execute(execution(), program)).toMatchObject({
        status,
        exitCode: ExitCode,
      });
    },
  );

  it.each(["timed_out", "output_limit", "cancelled"] as const)(
    "removes the container after %s without reusing an aborted signal",
    async (stopReason) => {
      const { sandbox, command } = fixture();
      const original = command.getMockImplementation();
      if (!original) throw new Error("Missing fixture transport");
      command.mockImplementation((bin, args, opts) =>
        args[0] === "start"
          ? Promise.resolve({
              ...ok("partial"),
              stderr: "err",
              exitCode: null,
              stopReason,
            })
          : original(bin, args, opts),
      );
      expect(await sandbox.execute(execution(), program)).toMatchObject({
        status: stopReason,
        stdout: "partial",
        stderr: "err",
        exitCode: null,
        cleanupConfirmed: true,
      });
      expect(command.mock.calls.map(([, args]) => args[0])).toEqual([
        "image",
        "create",
        "start",
        "rm",
      ]);
      expect(command.mock.calls.at(-1)?.[2].signal).toBeUndefined();
    },
  );

  it("does no provisioning when cancelled before or during preflight", async () => {
    const { sandbox, command } = fixture();
    const controller = new AbortController();
    controller.abort();
    await expect(
      sandbox.execute(execution(), program, controller.signal),
    ).rejects.toThrow("cancelled");
    expect(command).not.toHaveBeenCalled();
    const other = new AbortController();
    command.mockImplementationOnce(() => {
      other.abort();
      return Promise.resolve(ok("{}"));
    });
    await expect(
      sandbox.execute(execution(), program, other.signal),
    ).rejects.toThrow("before provisioning");
    expect(command).toHaveBeenCalledOnce();
  });

  it("cleans up without starting when cancelled during create", async () => {
    const { sandbox, command } = fixture();
    const controller = new AbortController();
    command.mockResolvedValueOnce(ok("{}"));
    command.mockImplementationOnce(() => {
      controller.abort();
      return Promise.resolve(ok());
    });
    expect(
      await sandbox.execute(execution(), program, controller.signal),
    ).toMatchObject({ status: "cancelled", cleanupConfirmed: true });
    expect(command.mock.calls.map(([, args]) => args[0])).toEqual([
      "image",
      "create",
      "rm",
    ]);
  });

  it("includes provisioning in the timeout and removes an unstarted container", async () => {
    const { sandbox, command } = fixture();
    let now = 1000;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    command.mockResolvedValueOnce(ok("{}"));
    command.mockImplementationOnce(() => {
      now += 31_000;
      return Promise.resolve(ok());
    });
    expect(await sandbox.execute(execution(), program)).toMatchObject({
      status: "timed_out",
    });
    expect(command.mock.calls.map(([, args]) => args[0])).toEqual([
      "image",
      "create",
      "rm",
    ]);
  });

  it.each([
    { Running: true },
    { ExitCode: null },
    { Error: "runtime failure" },
    { Status: "dead" },
    { OOMKilled: undefined },
  ])("requires confirmed termination: %j", async (invalid) => {
    const { sandbox, command } = fixture();
    const original = command.getMockImplementation();
    if (!original) throw new Error("Missing fixture transport");
    command.mockImplementation((bin, args, opts) =>
      args[0] === "inspect"
        ? Promise.resolve(ok(JSON.stringify({ ...exited, ...invalid })))
        : original(bin, args, opts),
    );
    await expect(sandbox.execute(execution(), program)).rejects.toThrow(
      "termination could not be confirmed",
    );
    expect(command.mock.calls.at(-1)?.[1][0]).toBe("rm");
  });

  it.each(["create", "start", "inspect"])(
    "cleans up after a %s transport failure and includes the reconciliation reference",
    async (operation) => {
      const { sandbox, command } = fixture();
      const original = command.getMockImplementation();
      if (!original) throw new Error("Missing fixture transport");
      command.mockImplementation((bin, args, opts) =>
        args[0] === operation
          ? Promise.reject(new Error("transport failed"))
          : original(bin, args, opts),
      );
      const error: unknown = await sandbox
        .execute(execution(), program)
        .catch((cause: unknown) => cause);
      expect(error).toBeInstanceOf(SandboxError);
      if (error instanceof SandboxError)
        expect(error.sandboxRef).toMatch(/^docker:sf-sandbox-/);
      expect(command.mock.calls.at(-1)?.[1][0]).toBe("rm");
    },
  );

  it("never exposes daemon errors as program output or succeeds after create failure", async () => {
    const { sandbox, command } = fixture();
    command.mockResolvedValueOnce(ok("{}"));
    command.mockResolvedValueOnce({
      ...ok(),
      exitCode: 1,
      stderr: "daemon secret",
    });
    await expect(sandbox.execute(execution(), program)).rejects.toThrow(
      "Sandbox creation failed",
    );
    expect(command.mock.calls.map(([, args]) => args[0])).toEqual([
      "image",
      "create",
      "rm",
    ]);
  });

  it("rejects Docker warnings about discarded resource limits before starting code", async () => {
    const { sandbox, command } = fixture();
    command.mockResolvedValueOnce(ok("{}"));
    command.mockResolvedValueOnce({
      ...ok("container-id"),
      stderr:
        "WARNING: Your kernel does not support memory limit capabilities. Limitation discarded.",
    });
    await expect(sandbox.execute(execution(), program)).rejects.toThrow(
      "resource enforcement required",
    );
    expect(command.mock.calls.map(([, args]) => args[0])).toEqual([
      "image",
      "create",
      "rm",
    ]);
  });

  it.each(["failure", "timeout", "throw"])(
    "raises a cleanup error if removal has %s",
    async (failure) => {
      const { sandbox, command } = fixture();
      const original = command.getMockImplementation();
      if (!original) throw new Error("Missing fixture transport");
      command.mockImplementation((bin, args, opts) => {
        if (args[0] !== "rm") return original(bin, args, opts);
        return failure === "throw"
          ? Promise.reject(new Error("offline"))
          : Promise.resolve({
              ...ok(),
              exitCode: 1,
              stopReason: failure === "timeout" ? "timed_out" : null,
            });
      });
      await expect(
        sandbox.execute(execution(), program),
      ).rejects.toBeInstanceOf(SandboxCleanupError);
    },
  );

  it("treats not-found after a timed-out create as uncertain cleanup", async () => {
    const { sandbox, command } = fixture();
    command.mockResolvedValueOnce(ok("{}"));
    command.mockResolvedValueOnce({
      ...ok(),
      exitCode: null,
      stopReason: "timed_out",
    });
    command.mockImplementationOnce((_bin, args) =>
      Promise.resolve({
        ...ok(),
        exitCode: 1,
        stderr: `Error response from daemon: No such container: ${String(args.at(-1))}`,
      }),
    );
    await expect(sandbox.execute(execution(), program)).rejects.toBeInstanceOf(
      SandboxCleanupError,
    );
  });

  it("does not confuse an already absent container after rejected create with failed cleanup", async () => {
    const { sandbox, command } = fixture();
    command.mockResolvedValueOnce(ok("{}"));
    command.mockResolvedValueOnce({ ...ok(), exitCode: 1 });
    command.mockImplementationOnce((_bin, args) =>
      Promise.resolve({
        ...ok(),
        exitCode: 1,
        stderr: `Error response from daemon: No such container: ${String(args.at(-1))}`,
      }),
    );
    await expect(sandbox.execute(execution(), program)).rejects.toThrow(
      "creation failed",
    );
  });
});
