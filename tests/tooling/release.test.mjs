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
import yaml from "js-yaml";

const root = fileURLToPath(new URL("../../", import.meta.url));
const release = yaml.load(
  readFileSync(join(root, ".github/workflows/release.yml"), "utf8"),
);
const ci = yaml.load(
  readFileSync(join(root, ".github/workflows/ci.yml"), "utf8"),
);

function repository(t) {
  const cwd = mkdtempSync(join(tmpdir(), "software-factory-release-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  function execute(command, args) {
    const stdoutPath = join(cwd, "stdout.log");
    const stderrPath = join(cwd, "stderr.log");
    const stdout = openSync(stdoutPath, "w");
    const stderr = openSync(stderrPath, "w");
    try {
      // Match the compiler regression test: sandboxed sync processes need
      // file-backed stdio instead of Node's synchronous pipe polling.
      const result = spawnSync(command, args, {
        cwd,
        stdio: ["ignore", stdout, stderr],
        timeout: 30_000,
      });
      assert.ifError(result.error);
      assert.equal(result.status, 0, readFileSync(stderrPath, "utf8"));
      return readFileSync(stdoutPath, "utf8");
    } finally {
      closeSync(stdout);
      closeSync(stderr);
    }
  }
  const git = (...args) => execute("git", args).trim();
  git("init", "--quiet");
  git("config", "user.name", "Release test");
  git("config", "user.email", "release@example.com");
  const commit = (message) =>
    git(
      "-c",
      "commit.gpgsign=false",
      "commit",
      "--quiet",
      "--allow-empty",
      "-m",
      message,
    );
  const notes = (tag, ref = "HEAD") =>
    execute(process.execPath, [
      join(root, "scripts/release-notes.mjs"),
      tag,
      ref,
    ]);
  return { git, commit, notes };
}

test("first release includes all history, required sections, and placeholder guidance", (t) => {
  const { git, commit, notes } = repository(t);
  commit("feat(api): add projects (Part 1/3): create");
  const hash = git("rev-parse", "HEAD");
  git("tag", "-a", "v0.1.0", "-m", "Initial release");
  const output = notes("v0.1.0", "v0.1.0");
  assert.match(output, /Initial placeholder release/);
  assert.match(output, /## What's new\n\n### Features/);
  assert.match(output, /\*\*api:\*\* add projects/);
  assert.match(output, /add projects \(Part 1\/3\): create/);
  assert.ok(output.includes(`/commit/${hash}`));
  assert.match(output, /## Breaking changes\n\nNo breaking changes recorded/);
  assert.match(
    output,
    /## Migration notes\n\nInitial release; no upgrade migration is required/,
  );
});

test("notes exclude previous releases and unrelated branches", (t) => {
  const { git, commit, notes } = repository(t);
  commit("feat: old feature");
  git("tag", "v0.1.0");
  git("checkout", "--quiet", "-b", "unrelated");
  commit("feat: unrelated feature");
  git("tag", "v9.0.0");
  git("checkout", "--quiet", "--detach", "v0.1.0");
  commit("fix: repair project search");
  git("tag", "v0.1.1");
  commit("feat: future feature");
  const output = notes("v0.1.1", "v0.1.1");
  assert.match(output, /### Bug Fixes/);
  assert.match(output, /repair project search/);
  assert.doesNotMatch(
    output,
    /old feature|unrelated feature|future feature|placeholder/,
  );
  assert.match(output, /compare\/v0.1.0\.\.\.v0.1.1/);
});

test("breaking and migration footers retain multiline guidance and hidden breaking commits", (t) => {
  const { commit, notes } = repository(t);
  commit(
    "chore!: remove legacy configuration\n\nBREAKING-CHANGE: Old keys are removed.\nUse the new schema.\n\nMIGRATION NOTES: Rename old_key to new_key.\n  Restart the service.\nRefs: #8",
  );
  commit(
    "feat(Phase 1: APIs)!: rename state\n\nMIGRATION: Read status instead.",
  );
  commit("docs: document status");
  commit("chore: invisible housekeeping");
  commit("An ordinary commit without a conventional header");
  const output = notes("v0.2.0");
  const breaking = output
    .split("## Breaking changes")[1]
    .split("## Migration notes")[0];
  const migration = output.split("## Migration notes")[1];
  assert.match(breaking, /Old keys are removed\.\n  Use the new schema/);
  assert.match(breaking, /rename state/);
  assert.doesNotMatch(breaking, /Rename old_key/);
  assert.match(
    migration,
    /Rename old_key to new_key\.\n    Restart the service/,
  );
  assert.match(migration, /Read status instead/);
  assert.doesNotMatch(migration, /Refs: #8/);
  assert.match(output, /### Documentation/);
  assert.doesNotMatch(
    output,
    /invisible housekeeping|ordinary commit|### Miscellaneous Chores/,
  );
});

test("empty release range has explicit fallback notes", (t) => {
  const { git, commit, notes } = repository(t);
  commit("chore: prepare");
  git("tag", "v0.1.0");
  assert.match(notes("v0.1.1"), /No user-facing changes recorded/);
  assert.match(notes("v0.1.1"), /No migration steps recorded/);
});

test("tag publication requires the reusable full CI workflow at the selected commit", () => {
  assert.deepEqual(release.on.push.tags, ["v*"]);
  assert.deepEqual(release.jobs.release.needs, ["prepare", "ci"]);
  assert.equal(release.jobs.ci.uses, "./.github/workflows/ci.yml");
  assert.equal(release.jobs.ci.with.ref, "${{ needs.prepare.outputs.sha }}");
  assert.equal(ci.on.workflow_call.inputs.ref.required, true);
  assert.equal(
    ci.jobs.validate.steps[0].with.ref,
    "${{ inputs.ref || github.sha }}",
  );
  const commands = ci.jobs.validate.steps
    .map((step) => step.run ?? "")
    .join("\n");
  for (const command of [
    "npm run lint",
    "npm run typecheck",
    "npm test",
    "npm run migrate:up",
    "npm run migrate:verify",
    "npm run migrate:down",
    "npm run test:e2e",
  ]) {
    assert.ok(commands.includes(command), `CI must include ${command}`);
  }
  assert.equal(release.permissions.contents, "read");
  assert.equal(release.jobs.release.permissions.contents, "write");
  assert.match(release.jobs.prepare.if, /conclusion == 'success'/);
  assert.match(
    release.jobs.prepare.if,
    /head_repository.full_name == github.repository/,
  );
});

test("bootstrap selects the passing main SHA and skips existing tags or stale CI", async () => {
  const script = release.jobs.prepare.steps[0].with.script;
  const run = new Function(
    "github",
    "context",
    "core",
    `return (async () => { ${script} })();`,
  );
  for (const scenario of ["new", "existing", "stale", "api-error"]) {
    const outputs = {};
    const github = {
      rest: {
        git: {
          getRef: async ({ ref }) => {
            if (ref === "tags/v0.1.0") {
              if (scenario === "existing") return { data: {} };
              throw Object.assign(new Error("API error"), {
                status: scenario === "api-error" ? 403 : 404,
              });
            }
            return {
              data: {
                object: { sha: scenario === "stale" ? "newer" : "tested" },
              },
            };
          },
        },
      },
    };
    const context = {
      eventName: "workflow_run",
      repo: { owner: "owner", repo: "repo" },
      payload: { workflow_run: { head_sha: "tested" } },
    };
    const core = {
      info() {},
      setOutput(key, value) {
        outputs[key] = value;
      },
    };
    if (scenario === "api-error") {
      await assert.rejects(run(github, context, core), /API error/);
    } else {
      await run(github, context, core);
      assert.deepEqual(
        outputs,
        scenario === "new"
          ? { publish: "true", tag: "v0.1.0", sha: "tested" }
          : {},
      );
    }
  }
});

test("tag pushes select the pushed commit and reject malformed version tags", async () => {
  const script = release.jobs.prepare.steps[0].with.script;
  const run = new Function(
    "context",
    "core",
    `return (async () => { ${script} })();`,
  );
  const outputs = {};
  const core = {
    setOutput(key, value) {
      outputs[key] = value;
    },
  };
  await run(
    { eventName: "push", ref: "refs/tags/v0.1.0", sha: "tagged" },
    core,
  );
  assert.deepEqual(outputs, { publish: "true", tag: "v0.1.0", sha: "tagged" });
  await assert.rejects(
    run({ eventName: "push", ref: "refs/tags/vinvalid" }, core),
    /Expected a version tag/,
  );
});
