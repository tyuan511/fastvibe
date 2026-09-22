#!/usr/bin/env node
/**
 * Draft release notes for a tag, straight from the commit history.
 *
 *   node .agents/skills/release/scripts/release-notes.mjs --tag v0.2.0
 *   node .agents/skills/release/scripts/release-notes.mjs --tag v0.2.0 --from v0.1.0
 *
 * Markdown goes to stdout (nothing else); the range being summarised goes to
 * stderr. The output is a *draft*: every entry is still an English commit
 * subject. Rewrite it into user-facing English prose before publishing — the
 * release note is read on GitHub by an international audience, so it must
 * contain no Chinese; see SKILL.md. Run it BEFORE the version-bump commit so the
 * notes cover only shipped work; `chore: release vX.Y.Z` is skipped either way.
 */
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// The repo this script ships in — not the process cwd, so it works from anywhere.
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");

function git(args) {
  try {
    return execFileSync("git", args, { cwd: ROOT, encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}

function fail(message) {
  console.error(`release-notes: ${message}`);
  process.exit(1);
}

const argv = process.argv.slice(2);
const value = (name) => {
  const index = argv.indexOf(name);
  return index === -1 ? undefined : argv[index + 1];
};
const tag = value("--tag");
if (!tag || !/^v?\d+\.\d+\.\d+/.test(tag)) fail("--tag vX.Y.Z is required");

const from =
  value("--from") ??
  git(["tag", "--merged", "HEAD", "--sort=-v:refname", "--list", "v[0-9]*"])
    .split("\n")
    .find((name) => name && name !== tag) ??
  "";
const range = from ? `${from}..HEAD` : "HEAD";

const remote = git(["remote", "get-url", "origin"]);
const repo = /github\.com[:/]([^/]+)\/([^/.]+?)(?:\.git)?$/.exec(remote);
const commitUrl = (hash) => (repo ? `https://github.com/${repo[1]}/${repo[2]}/commit/${hash}` : "");
const compareUrl = repo && from ? `https://github.com/${repo[1]}/${repo[2]}/compare/${from}...${tag}` : "";

const SECTIONS = [
  ["feat", "Added"],
  ["fix", "Fixed"],
  ["perf", "Performance"],
  ["refactor", "Refactor"],
  ["docs", "Docs"],
];
const BREAKING = "Breaking changes";
const MISC = "Build & chores";
const TRAILER = /^(Co-authored-by|Signed-off-by|Reviewed-by|Generated with|🤖)/i;

/** One bullet per `- ` item, one bullet per prose block; wrapped lines rejoin. */
function bulletsOf(body) {
  const bullets = [];
  let breaking = false;
  for (const paragraph of body.split(/\n\s*\n/)) {
    const lines = paragraph
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    if (!lines.length || TRAILER.test(lines[0])) continue;
    if (/^BREAKING CHANGES?:/i.test(lines[0])) {
      breaking = true;
      bullets.push(lines.join(" ").replace(/^BREAKING CHANGES?:/i, "").trim());
      continue;
    }
    let kind = null;
    for (const line of lines) {
      if (/^[-*] /.test(line)) {
        bullets.push(line.replace(/^[-*] /, ""));
        kind = "bullet";
      } else if (bullets.length && kind) {
        bullets[bullets.length - 1] += ` ${line}`;
      } else {
        bullets.push(line);
        kind = "prose";
      }
    }
  }
  return { bullets, breaking };
}

function parseCommit(entry) {
  const [hash, subject, body = ""] = entry.split("\x1f");
  const parsed = /^([a-z]+)(?:\(([^)]+)\))?(!)?: (.*)$/.exec(subject);
  const { bullets, breaking } = bulletsOf(body);
  return {
    hash,
    short: hash.slice(0, 7),
    type: parsed ? parsed[1] : "",
    scope: parsed?.[2] ?? "",
    title: parsed ? parsed[4] : subject,
    breaking: breaking || Boolean(parsed?.[3]),
    bullets,
  };
}

const log = git(["log", "--no-merges", "--pretty=%H%x1f%s%x1f%b%x1e", range]);
const commits = log
  .split("\x1e")
  .map((entry) => entry.trim())
  .filter(Boolean)
  .map(parseCommit)
  // `chore: release v0.2.0` / `chore: set version to 0.2.0` is bookkeeping for the
  // release itself, not a change in it.
  .filter(
    (commit) =>
      !(commit.type === "chore" && /\d+\.\d+\.\d+/.test(commit.title) && /(release|version)/i.test(commit.title)),
  );

const breaking = commits.filter((commit) => commit.breaking);
const sections = [];
// A breaking commit is listed once, at the top, not again under its own type.
if (breaking.length) sections.push([BREAKING, breaking]);
for (const [type, title] of SECTIONS) {
  const group = commits.filter((commit) => commit.type === type && !commit.breaking);
  if (group.length) sections.push([title, group]);
}
const misc = commits.filter(
  (commit) => !commit.breaking && !SECTIONS.some(([type]) => type === commit.type),
);
if (misc.length) sections.push([MISC, misc]);

function render(commit) {
  const scope = commit.scope ? `**${commit.scope}**: ` : "";
  const link = commitUrl(commit.hash);
  const ref = link ? ` ([${commit.short}](${link}))` : ` (${commit.short})`;
  const head = `- ${commit.breaking ? "**BREAKING** " : ""}${scope}${commit.title}${ref}`;
  return [head, ...commit.bullets.map((bullet) => `  - ${bullet}`)].join("\n");
}

console.error(
  `release-notes: ${commits.length} commits (${range})${from ? "" : " — no previous tag, covering the whole history"}`,
);

const body = sections
  .map(([title, group]) => `### ${title}\n\n${group.map(render).join("\n")}`)
  .join("\n\n");

console.log(
  [body || "### Changes\n\n- None", compareUrl ? `**Full Changelog**: ${compareUrl}` : ""]
    .filter(Boolean)
    .join("\n\n"),
);
