#!/usr/bin/env node
/**
 * Assert that the release note for the tag being built exists in the repo.
 *
 *   node scripts/check-release-note.mjs            # uses GITHUB_REF_NAME
 *   node scripts/check-release-note.mjs --tag v0.11.0
 *
 * A release's body is `docs/release/<tag>.md`, committed with the version bump. The
 * tag is what selects it, so the note has to be named after the tag and has to be
 * there *before* the tag is pushed. This is run by every job in release.yml, near the
 * top: without it a tag whose note was never added still spends twenty minutes
 * packaging and then publishes a release with an empty body, which is the one thing
 * about a release nobody can fix in a rerun.
 *
 * It checks no further than that. The note is written in English (see
 * `.agents/skills/release/SKILL.md` and `docs/release/README.md`) because it is read
 * on GitHub by an international audience, but that is a writing guideline, not a gate:
 * a note somebody chose to publish in another language is a deliberate choice this
 * script has no business overriding, and a release that cannot go out because of a
 * regex is worse than one whose prose is in the wrong language.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// The repo this script ships in — not the process cwd. `root` is injectable so a test can
// point it at a fixture tree instead of writing into the real `docs/release/`.
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** `v1.2.3` and `v1.2.3-rc.1`; not `latest`, not `1.2.3`. */
export const RELEASE_TAG = /^v\d+\.\d+\.\d+/;

/**
 * Returns `{ tag, path, lines }` when the note is present and has content, otherwise
 * throws with the reason. Every refusal is phrased as the fix — the caller is a CI log
 * somebody is reading once.
 */
export function checkReleaseNote(tag, root = ROOT) {
  if (!tag) throw new Error("no tag: set GITHUB_REF_NAME or pass --tag vX.Y.Z");
  if (!RELEASE_TAG.test(tag)) throw new Error(`not a release tag: ${tag} (expected vX.Y.Z)`);

  const path = join(root, "docs", "release", `${tag}.md`);
  const relative = `docs/release/${tag}.md`;
  if (!existsSync(path)) throw new Error(`missing release note: ${relative}`);

  const note = readFileSync(path, "utf8");
  if (!note.trim()) throw new Error(`release note is empty: ${relative}`);

  return { tag, path, lines: note.trim().split("\n").length };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const index = argv.indexOf("--tag");
  const tag = index === -1 ? process.env.GITHUB_REF_NAME : argv[index + 1];
  try {
    const { lines } = checkReleaseNote(tag);
    console.error(`check-release-note: docs/release/${tag}.md (${lines} lines)`);
  } catch (error) {
    console.error(`check-release-note: ${error.message}`);
    process.exit(1);
  }
}
