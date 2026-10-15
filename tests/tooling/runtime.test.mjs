import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  closeSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("../../", import.meta.url));

test("repository agent runtime: failover, verification, lifecycle and local Git publication", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "sf-runtime-tests-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const logPath = join(directory, "runtime.log");
  const output = openSync(logPath, "w");
  try {
    const result = spawnSync(
      "python3",
      [
        "-m",
        "unittest",
        "discover",
        "-s",
        "tests/runtime",
        "-p",
        "test_*.py",
        "-v",
      ],
      { cwd: root, stdio: ["ignore", output, output], timeout: 60_000 },
    );
    assert.ifError(result.error);
    assert.equal(result.status, 0, readFileSync(logPath, "utf8"));
  } finally {
    closeSync(output);
  }
});
