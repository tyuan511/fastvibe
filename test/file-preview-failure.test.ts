import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { readFilePreview, previewFailure } from "../src/main/engine/file-preview.ts";
import type { FilePreview } from "../src/shared/types.ts";

/**
 * What the pane shows when a file cannot be read.
 *
 * The host's own sentence used to be the whole preview, so a file that had simply been moved
 * printed `ENOENT: no such file or directory, stat '…'` in red. The contract these tests hold
 * is the opposite: the reader gets a verdict by `reason`, the raw error never replaces it, and
 * the folder the file should be in is named so the UI can offer it.
 */

function failure(preview: FilePreview): Extract<FilePreview, { kind: "error" }> {
  assert.equal(preview.kind, "error", `expected an error preview, got ${preview.kind}`);
  return preview;
}

function workspace(): string {
  const cwd = mkdtempSync(join(tmpdir(), "fastvibe-preview-"));
  mkdirSync(join(cwd, "docs"), { recursive: true });
  writeFileSync(join(cwd, "docs", "live.md"), "# live\n");
  return cwd;
}

test("a missing file is reported as missing, not as an errno", () => {
  const cwd = workspace();
  const path = join(cwd, "docs", "DESIGN.md");
  const preview = failure(readFilePreview(path));

  assert.equal(preview.reason, "missing");
  assert.equal(preview.name, "DESIGN.md");
  assert.equal(preview.directory, dirname(path));
  // The friendly line is what a reader sees; the errno is only the small print.
  assert.doesNotMatch(preview.message, /ENOENT|no such file|stat /);
  assert.match(preview.detail ?? "", /ENOENT/);
});

test("a path under a file, not a directory, is missing too", () => {
  const cwd = workspace();
  // ENOTDIR: `live.md` exists but cannot contain anything.
  const preview = failure(readFilePreview(join(cwd, "docs", "live.md", "nested.md")));
  assert.equal(preview.reason, "missing");
});

test("a directory is named as one, and points at itself", () => {
  const cwd = workspace();
  const dir = join(cwd, "docs");
  const preview = failure(readFilePreview(dir));

  assert.equal(preview.reason, "not-a-file");
  assert.doesNotMatch(preview.message, /EISDIR/);
  // Revealing a folder means opening it, so the way out is the path itself.
  assert.equal(preview.directory, dir);
});

test("an unreadable file is a permission problem", (t) => {
  if (typeof process.getuid === "function" && process.getuid() === 0) {
    // root reads anything; the chmod below would prove nothing.
    t.skip("running as root");
    return;
  }
  const cwd = workspace();
  const path = join(cwd, "docs", "secret.md");
  writeFileSync(path, "hush\n");
  chmodSync(path, 0o000);
  t.after(() => chmodSync(path, 0o644));

  const preview = failure(readFilePreview(path));
  assert.equal(preview.reason, "permission");
  assert.doesNotMatch(preview.message, /EACCES/);
  assert.equal(preview.directory, dirname(path));
});

test("a file that can be read is untouched by all this", () => {
  const cwd = workspace();
  const preview = readFilePreview(join(cwd, "docs", "live.md"));
  assert.equal(preview.kind, "markdown");
});

test("a failure nothing classifies keeps the host's words", () => {
  const cwd = workspace();
  const path = join(cwd, "docs", "live.md");
  const preview = failure(previewFailure(path, "live.md", new Error("disk is on fire")));

  assert.equal(preview.reason, "unknown");
  // There is no better sentence than the one the host gave, so it is the headline here.
  assert.equal(preview.message, "disk is on fire");
  assert.equal(preview.directory, dirname(path));
});
