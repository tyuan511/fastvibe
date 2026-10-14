import assert from "node:assert/strict";
import { existsSync, lstatSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { editableFileText, prefersSourceEditor } from "../src/shared/editable-preview.ts";
import { MAX_TEXT_FILE_BYTES, writeWorkspaceTextFile } from "../src/main/engine/workspace-fs.ts";
import type { FilePreview } from "../src/shared/types.ts";

async function withDir(fn: (dir: string) => Promise<void> | void): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "fastvibe-write-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("a save replaces the file and puts CRLF back", async () => {
  await withDir((dir) => {
    const file = join(dir, "note.txt");
    writeFileSync(file, "a\r\nb\r\n", { mode: 0o640 });
    writeWorkspaceTextFile(file, "a\nb\nc\n");
    assert.equal(readFileSync(file, "utf8"), "a\r\nb\r\nc\r\n");
    assert.equal(lstatSync(file).mode & 0o777, 0o640);
    const lf = join(dir, "lf.txt");
    writeFileSync(lf, "a\nb\n");
    writeWorkspaceTextFile(lf, "a\nz\n");
    assert.equal(readFileSync(lf, "utf8"), "a\nz\n");
  });
});

test("a save refuses a symlink, a directory, a missing path, and a binary", async () => {
  await withDir((dir) => {
    const real = join(dir, "real.txt");
    const link = join(dir, "link.txt");
    writeFileSync(real, "secret");
    symlinkSync(real, link);
    assert.throws(() => writeWorkspaceTextFile(link, "nope"), /普通文件|regular file/);
    assert.equal(readFileSync(real, "utf8"), "secret");
    assert.throws(() => writeWorkspaceTextFile(dir, "nope"), /普通文件|regular file/);
    assert.throws(() => writeWorkspaceTextFile(join(dir, "missing.txt"), "nope"), /不存在|does not exist/);
    assert.equal(existsSync(join(dir, "missing.txt")), false);
    const binary = join(dir, "blob.bin");
    writeFileSync(binary, Buffer.from([0x00, 0x01, 0x02]));
    assert.throws(() => writeWorkspaceTextFile(binary, "text"), /二进制|binary/);
    assert.deepEqual(readFileSync(binary), Buffer.from([0x00, 0x01, 0x02]));
  });
});

test("a file past the editor cap is left untouched", async () => {
  await withDir((dir) => {
    const file = join(dir, "big.txt");
    writeFileSync(file, Buffer.alloc(MAX_TEXT_FILE_BYTES + 1, 0x61));
    assert.throws(() => writeWorkspaceTextFile(file, "nope"), /过大|too large/);
    assert.equal(lstatSync(file).size, MAX_TEXT_FILE_BYTES + 1);
  });
});

test("only text that is the file itself can be written back", () => {
  const code: FilePreview = { kind: "code", path: "/tmp/a.ts", name: "a.ts", language: "ts", text: "let n = 1;\n" };
  const markdown: FilePreview = { kind: "markdown", path: "/tmp/note.md", name: "note.md", text: "# hi\n" };
  const docx: FilePreview = { kind: "markdown", path: "/tmp/note.docx", name: "note.docx", text: "extracted" };
  const image: FilePreview = { kind: "image", path: "/tmp/a.png", name: "a.png", mimeType: "image/png", size: 4 };
  assert.equal(editableFileText(code), "let n = 1;\n");
  assert.equal(prefersSourceEditor(code), true);
  assert.equal(editableFileText(markdown), "# hi\n");
  assert.equal(prefersSourceEditor(markdown), false);
  assert.equal(editableFileText(docx), null);
  assert.equal(editableFileText(image), null);
});
