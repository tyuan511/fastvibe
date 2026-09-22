import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkReleaseNote } from "../scripts/check-release-note.mjs";

// The checker is what stands between a tag and a published release whose body is empty, so
// every refusal is pinned here — and so is what it deliberately does *not* refuse. It reads
// one file at one path, and the path is the only thing the workflow hands it, so the
// contract is entirely about which files it accepts and why it says no.
function fixture(notes: Record<string, string>, run: (root: string) => void) {
  const root = mkdtempSync(join(tmpdir(), "release-note-"));
  try {
    mkdirSync(join(root, "docs", "release"), { recursive: true });
    for (const [name, body] of Object.entries(notes)) {
      writeFileSync(join(root, "docs", "release", name), body);
    }
    run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const throws = (fn: () => unknown, pattern: RegExp) =>
  assert.throws(fn, (error: Error) => pattern.test(error.message));

test("accepts the note named after the tag, prerelease tags included", () => {
  fixture({ "v0.11.0.md": "### Added\n\n- A thing.\n", "v0.11.0-rc.1.md": "### Fixed\n\n- A bug.\n" }, (root) => {
    assert.equal(checkReleaseNote("v0.11.0", root).lines, 3);
    assert.equal(checkReleaseNote("v0.11.0-rc.1", root).tag, "v0.11.0-rc.1");
  });
});

test("refuses a note it cannot find, name it what it may", () => {
  fixture({ "v0.11.0.md": "### Added\n\n- A thing.\n" }, (root) => {
    // The tag is what selects the file: 0.11.0, or a tag with no note at all.
    throws(() => checkReleaseNote("0.11.0", root), /not a release tag/);
    throws(() => checkReleaseNote("v0.11.1", root), /missing release note: docs\/release\/v0\.11\.1\.md/);
    throws(() => checkReleaseNote("latest", root), /not a release tag/);
    throws(() => checkReleaseNote("", root), /no tag/);
  });
});

test("refuses an empty note, and one that is only whitespace", () => {
  fixture({ "v0.11.0.md": "", "v0.11.1.md": "   \n\n\t\n" }, (root) => {
    throws(() => checkReleaseNote("v0.11.0", root), /release note is empty/);
    throws(() => checkReleaseNote("v0.11.1", root), /release note is empty/);
  });
});

test("does not police the language — a non-English note is published as written", () => {
  fixture({ "v0.11.0.md": "### 修复\n\n- 用时 显示错误。\n" }, (root) => {
    // English is the guideline for notes, not a gate: a release must not be blockable by a
    // regex over prose. What is checked is that the file is there and says something.
    assert.equal(checkReleaseNote("v0.11.0", root).lines, 3);
  });
});
