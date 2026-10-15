import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { promisify } from "node:util";

const [tag, ref = tag] = process.argv.slice(2);
if (
  !tag ||
  !/^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(tag)
) {
  throw new Error(
    "Usage: node scripts/release-notes.mjs vMAJOR.MINOR.PATCH [ref]",
  );
}

const config = JSON.parse(
  readFileSync(new URL("../.versionrc", import.meta.url)),
);
const execute = promisify(execFile);
const git = async (...args) => (await execute("git", args)).stdout.trim();
// Resolve to a commit before using a ref in any history query (also peels tags).
const sha = await git("rev-parse", "--verify", `${ref}^{commit}`);
const tags = (
  await git("tag", "--merged", sha, "--sort=-version:refname", "--list", "v*")
)
  .split("\n")
  .filter((candidate) => candidate && candidate !== tag);
const previous = tags.find((candidate) =>
  /^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(candidate),
);
const range = previous ? `${previous}..${sha}` : sha;
const commits = (await git("log", "--reverse", "--format=%H%x00%B%x00", range))
  .split("\x00\n")
  .filter(Boolean);
const sections = new Map();
const breaking = [];
const migrations = [];
const link = (hash) => config.commitUrlFormat.replace("{{hash}}", hash);

for (const commit of commits) {
  const [hash, message = ""] = commit.split("\x00");
  const [header, ...body] = message.trim().split("\n");
  const match = /^(\w+)(?:\(([^)]+)\))?(!)?:\s+(.+)$/.exec(header);
  if (!match) continue;
  const [, type, scope, bang, subject] = match;
  const entry = `${scope ? `**${scope}:** ` : ""}${subject} ([${hash.slice(0, 7)}](${link(hash)}))`;
  const rule = config.types.find((candidate) => candidate.type === type);
  if (rule && !rule.hidden) {
    const entries = sections.get(rule.section) ?? [];
    entries.push(entry);
    sections.set(rule.section, entries);
  }

  // Footers may contain paragraphs and indented continuation lines. Stop at
  // the next trailer so migration guidance is not swallowed by breaking notes.
  let active;
  let hasBreakingFooter = false;
  for (const line of body) {
    const footer =
      /^(BREAKING[ -]CHANGE|MIGRATION(?:[ -]NOTES)?):\s*(.*)$/i.exec(line);
    if (footer) {
      const isBreaking = footer[1].toUpperCase().startsWith("BREAKING");
      hasBreakingFooter ||= isBreaking;
      active = {
        entry,
        lines: [footer[2]],
      };
      (isBreaking ? breaking : migrations).push(active);
    } else if (/^[\w-]+(?: #|: )/.test(line)) {
      active = undefined;
    } else if (active) {
      active.lines.push(line);
    }
  }
  if (bang && !hasBreakingFooter) {
    // A bang is sufficient even when the author omitted a breaking footer.
    breaking.push({ lines: [subject], entry });
  }
}

const lines = [`# Software Factory ${tag}`, ""];
if (tag === "v0.1.0" && !previous) {
  lines.push("Initial placeholder release of Software Factory.", "");
}
lines.push("## What's new", "");
for (const { section, hidden } of config.types) {
  if (hidden || !sections.has(section)) continue;
  lines.push(
    `### ${section}`,
    "",
    ...sections.get(section).map((entry) => `- ${entry}`),
    "",
  );
}
if (!sections.size) lines.push("No user-facing changes recorded.", "");
for (const [heading, notes, fallback] of [
  ["Breaking changes", breaking, "No breaking changes recorded."],
  [
    "Migration notes",
    migrations,
    previous
      ? "No migration steps recorded."
      : "Initial release; no upgrade migration is required.",
  ],
]) {
  lines.push(`## ${heading}`, "");
  lines.push(
    ...(notes.length
      ? notes.map(
          (note) =>
            `- ${note.lines.join("\n").trim().replaceAll("\n", "\n  ")} — ${note.entry}`,
        )
      : [fallback]),
    "",
  );
}
if (previous) {
  const compare = config.compareUrlFormat
    .replace("{{previousTag}}", previous)
    .replace("{{currentTag}}", tag);
  lines.push(`[Full changelog](${compare})`, "");
}
process.stdout.write(`${lines.join("\n")}\n`);
