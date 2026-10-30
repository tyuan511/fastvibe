#!/usr/bin/env node
/**
 * Assert that the release note for the tag being built exists in the repo.
 *
 *   node scripts/check-release-note.mjs            # uses GITHUB_REF_NAME
 *   node scripts/check-release-note.mjs --tag v0.11.0
 *
 * A release's body is `docs/release/<tag>.md`, committed with the version bump. The
 * tag is what selects it, so the note has to be named after the tag and has to be
 * there *before* the tag is pushed. The phone app's `app-vX.Y.Z` tags follow the same
 * rule (`docs/release/app-vX.Y.Z.md`), and the app shows that body as its 更新日志. This
 * is run by every job in release.yml, and by mobile-android.yml, near the top: without it a tag whose note was never added still spends twenty minutes
 * packaging and then publishes a release with an empty body, which is the one thing
 * about a release nobody can fix in a rerun.
 *
 * New notes link to a matching Simplified Chinese file. When a language link or
 * translation is present, check both files and their reciprocal absolute URLs.
 * Legacy single-language notes remain valid for historical rebuilds. This checks
 * structure, not prose language or translation quality; see docs/release/README.md.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// The repo this script ships in — not the process cwd. `root` is injectable so a test can
// point it at a fixture tree instead of writing into the real `docs/release/`.
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const NOTES_URL = "https://github.com/tyuan511/fastvibe/blob";

/** `v1.2.3`, `v1.2.3-rc.1` and the phone app's `app-v1.2.3`; not `latest`, not `1.2.3`. */
export const RELEASE_TAG = /^(app-|native-)?v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

/**
 * Returns note metadata when the note is present and has content, otherwise
 * throws with the reason. Every refusal is phrased as the fix — the caller is a CI log
 * somebody is reading once.
 */
export function checkReleaseNote(tag, root = ROOT) {
  if (!tag) throw new Error("no tag: set GITHUB_REF_NAME or pass --tag vX.Y.Z");
  if (!RELEASE_TAG.test(tag)) throw new Error(`not a release tag: ${tag} (expected vX.Y.Z, app-vX.Y.Z or native-vX.Y.Z)`);

  const path = join(root, "docs", "release", `${tag}.md`);
  const relative = `docs/release/${tag}.md`;
  if (!existsSync(path)) throw new Error(`missing release note: ${relative}`);

  const note = readFileSync(path, "utf8");
  if (!note.trim()) throw new Error(`release note is empty: ${relative}`);

  const translationPath = join(root, "docs", "release", `${tag}_zh-CN.md`);
  const bilingual = existsSync(translationPath) || note.includes("[简体中文](");
  if (bilingual) {
    const translationRelative = `docs/release/${tag}_zh-CN.md`;
    if (!existsSync(translationPath)) throw new Error(`missing Chinese release note: ${translationRelative}`);
    const translation = readFileSync(translationPath, "utf8");
    if (!translation.trim()) throw new Error(`Chinese release note is empty: ${translationRelative}`);

    // New releases pin to their tag. A translation added after publication lives
    // on main: moving an existing tag just to add prose would change shipped source.
    const ref = [tag, "main"].find((ref) =>
      note.includes(`**English** | [简体中文](${NOTES_URL}/${ref}/${translationRelative})`),
    );
    if (!ref) throw new Error(`add an absolute Chinese language link for ${tag} to ${relative} (see docs/release/README.md)`);
    if (!translation.includes(`[English](${NOTES_URL}/${ref}/${relative}) | **简体中文**`)) {
      throw new Error(`add the matching absolute English language link to ${translationRelative}`);
    }
  }

  return { tag, path, lines: note.trim().split("\n").length, translationPath: bilingual ? translationPath : undefined };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const index = argv.indexOf("--tag");
  const tag = index === -1 ? process.env.GITHUB_REF_NAME : argv[index + 1];
  try {
    const { lines, translationPath } = checkReleaseNote(tag);
    console.error(`check-release-note: docs/release/${tag}.md (${lines} lines)${translationPath ? " + Simplified Chinese" : ""}`);
  } catch (error) {
    console.error(`check-release-note: ${error.message}`);
    process.exit(1);
  }
}
