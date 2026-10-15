import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("../../", import.meta.url));

test("lint:tsc rejects type errors in every source workspace", () => {
  const fixture = mkdtempSync(join(tmpdir(), "software-factory-typecheck-"));
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const workspaces = manifest.workspaces.flatMap((pattern) => {
    const parent = pattern.replace(/\/\*$/, "");
    return readdirSync(join(root, parent)).map((name) => join(parent, name));
  });
  const sourceWorkspaces = [
    ...workspaces.filter((workspace) => existsSync(join(root, workspace, "src"))),
    "tests/e2e",
  ];

  function copyConfig(relativePath) {
    const destination = join(fixture, relativePath);
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(join(root, relativePath), destination);
  }

  function typecheck() {
    const outputPath = join(fixture, "compiler.log");
    const outputFd = openSync(outputPath, "w");
    try {
      // File-backed stdio also works where sandboxed Node cannot poll pipes.
      const result = spawnSync("npm", ["run", "lint:tsc"], {
        cwd: fixture,
        stdio: ["ignore", outputFd, outputFd],
        timeout: 120_000,
        env: { ...process.env, NO_COLOR: "1" },
      });
      assert.ifError(result.error);
      return {
        status: result.status,
        output: readFileSync(outputPath, "utf8"),
      };
    } finally {
      closeSync(outputFd);
    }
  }

  try {
    symlinkSync(
      join(root, "node_modules"),
      join(fixture, "node_modules"),
      "dir",
    );
    writeFileSync(
      join(fixture, "package.json"),
      JSON.stringify({ type: "module", scripts: manifest.scripts }),
    );
    for (const file of [
      "tsconfig.json",
      "tsconfig.base.json",
      "tsconfig.tools.json",
      "packages/tsconfig/base.json",
      "packages/tsconfig/strict.json",
    ]) {
      copyConfig(file);
    }
    writeFileSync(join(fixture, "vitest.config.ts"), "export {};\n");
    assert.ok(sourceWorkspaces.length > 0);
    for (const workspace of sourceWorkspaces) {
      copyConfig(join(workspace, "tsconfig.json"));
      mkdirSync(join(fixture, workspace, "src"), { recursive: true });
      writeFileSync(
        join(fixture, workspace, "src", "fixture.ts"),
        "export const value: number = 1;\n",
      );
    }

    const clean = typecheck();
    assert.equal(clean.status, 0, clean.output);

    // Check the actual root script against the real project graph, without
    // changing source files or relying on stale build metadata in the repo.
    for (const workspace of sourceWorkspaces) {
      writeFileSync(
        join(fixture, workspace, "src", "fixture.ts"),
        'export const value: number = "intentional type error";\n',
      );
    }
    const invalid = typecheck();
    assert.notEqual(invalid.status, 0, invalid.output);
    for (const workspace of sourceWorkspaces) {
      assert.ok(
        invalid.output.includes(
          `${workspace}/src/fixture.ts(1,14): error TS2322`,
        ),
        `Type error in ${workspace} was not reported:\n${invalid.output}`,
      );
    }
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});
