/** Opt-in real OCI smoke tests; these do not attest production strong isolation. */
import { afterAll, describe, expect, it } from "vitest";
import { DockerSandbox } from "../index.js";
import { runCommand } from "../command.js";
import { execution } from "./fixtures.js";

const image = process.env["SANDBOX_TEST_IMAGE"];
const enabled = process.env["SANDBOX_DOCKER_TESTS"] === "1";

describe.skipIf(!enabled)("real Docker sandbox", () => {
  if (enabled && !image)
    throw new Error(
      "SANDBOX_TEST_IMAGE must name a preloaded digest-pinned Node image",
    );
  const sandbox = enabled && image ? new DockerSandbox({ image }) : null;
  const refs: string[] = [];
  async function run(code: string, limits = {}) {
    if (!sandbox) throw new Error("Sandbox integration test not configured");
    const result = await sandbox.execute(execution(), {
      code,
      trust: "trusted",
      limits,
    });
    refs.push(result.sandboxRef.slice("docker:".length));
    return result;
  }

  it("isolates filesystem, identity, capabilities, environment and network", async () => {
    const result = await run(`
      const fs = require('node:fs');
      const assert = require('node:assert/strict');
      const net = require('node:net');
      assert.equal(process.getuid(), 65534);
      assert.equal(process.env.HOME, '/tmp');
      assert.equal(process.env.DATABASE_URL, undefined);
      assert.equal(fs.existsSync('/var/run/docker.sock'), false);
      assert.equal(fs.existsSync('/root/.ssh/id_rsa'), false);
      assert.match(fs.readFileSync('/proc/self/status', 'utf8'), /CapEff:\\s+0+\\n/);
      assert.throws(() => fs.writeFileSync('/escape', 'forbidden'));
      fs.writeFileSync('/workspace/test', 'ephemeral');
      const socket = net.connect({ host: '169.254.169.254', port: 80 });
      socket.on('connect', () => { process.exitCode = 1; socket.destroy(); });
      socket.on('error', () => console.log('isolated'));
      socket.setTimeout(500, () => { console.log('isolated'); socket.destroy(); });
      console.error('stderr captured');
    `);
    expect(result).toMatchObject({
      status: "succeeded",
      stdout: "isolated\n",
      stderr: "stderr captured\n",
    });
    const fresh = await run(
      "console.log(require('node:fs').existsSync('/workspace/test'))",
    );
    expect(fresh.stdout).toBe("false\n");
  }, 20_000);

  it("reports user code failures", async () => {
    expect(
      await run("console.error('failed'); process.exitCode = 7"),
    ).toMatchObject({ status: "failed", exitCode: 7, stderr: "failed\n" });
  }, 20_000);

  it("kills CPU loops and output floods, then confirms removal", async () => {
    expect(await run("while(true) {}", { timeoutMs: 2000 })).toMatchObject({
      status: "timed_out",
      cleanupConfirmed: true,
    });
    const flood = await run(
      "while(true) process.stdout.write('x'.repeat(10000))",
      { maxOutputBytes: 1024 },
    );
    expect(flood.status).toBe("output_limit");
    expect(Buffer.byteLength(flood.stdout)).toBe(1024);
  }, 20_000);

  it("enforces the cgroup memory limit", async () => {
    const result = await run(
      "const blocks=[]; while(true) blocks.push(Buffer.alloc(8*1024*1024, 1))",
      { memoryMb: 64 },
    );
    expect(result.status).toBe("out_of_memory");
  }, 20_000);

  afterAll(async () => {
    for (const name of refs) {
      const result = await runCommand("docker", ["inspect", name], {
        timeoutMs: 5000,
        maxOutputBytes: 65536,
      });
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("No such");
    }
  });
});
