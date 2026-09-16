#!/usr/bin/env node
/**
 * Bump the root package.json version.
 *
 *   node .agents/skills/release/scripts/bump-version.mjs --dry-run
 *   node .agents/skills/release/scripts/bump-version.mjs patch
 *   node .agents/skills/release/scripts/bump-version.mjs 0.2.0
 *
 * With no argument the level is inferred from the commits since the last
 * release tag: a `!` / `BREAKING CHANGE:` commit is major, a `feat:` is minor,
 * anything else is patch. Only package.json is touched — the release commit,
 * the tag and the push are the agent's job (see SKILL.md), so the notes can be
 * generated from the history *before* the version commit joins it.
 *
 * stdout is the new version and nothing else, so callers can capture it.
 * Everything else goes to stderr.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const PKG = resolve(ROOT, "package.json");

function git(args) {
  try {
    return execFileSync("git", args, { cwd: ROOT, encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}

function fail(message) {
  console.error(`bump-version: ${message}`);
  process.exit(1);
}

const argv = process.argv.slice(2);
const dryRun = argv.includes("--dry-run");
const input = argv.find((arg) => !arg.startsWith("-"));

const pkg = JSON.parse(readFileSync(PKG, "utf8"));
const current = pkg.version;
if (!/^\d+\.\d+\.\d+/.test(current)) fail(`package.json version ${current} is not semver`);

/** Last vX.Y.Z tag reachable from HEAD, i.e. the release this one follows. */
const previousTag = git(["describe", "--tags", "--abbrev=0", "--match", "v[0-9]*", "HEAD"]);
const range = previousTag ? `${previousTag}..HEAD` : "HEAD";
const subjects = git(["log", "--no-merges", "--pretty=%s", range]).split("\n").filter(Boolean);
const bodies = git(["log", "--no-merges", "--pretty=%b", range]);

let level;
if (input && /^\d+\.\d+\.\d+/.test(input.replace(/^v/, ""))) {
  level = "explicit";
} else if (input) {
  if (!["patch", "minor", "major"].includes(input)) fail("expected patch | minor | major | X.Y.Z");
  level = input;
} else if (!subjects.length) {
  level = "patch";
} else if (subjects.some((s) => /^[a-z]+(\(.+\))?!:/.test(s)) || /BREAKING CHANGE:/.test(bodies)) {
  level = "major";
} else if (subjects.some((s) => /^feat(\(.+\))?:/.test(s))) {
  level = "minor";
} else {
  level = "patch";
}

function next(from, kind) {
  const [major, minor, patch] = from.split(".").map(Number);
  if (kind === "major") return `${major + 1}.0.0`;
  if (kind === "minor") return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

const version =
  level === "explicit" ? input.replace(/^v/, "") : next(current, level);

console.error(
  `bump-version: ${current} -> ${version} (${level}, ${subjects.length} commits since ${previousTag || "the first commit"})`,
);
if (dryRun) {
  console.log(version);
  process.exit(0);
}

pkg.version = version;
writeFileSync(PKG, `${JSON.stringify(pkg, null, 2)}\n`);
console.log(version);
