import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MAX_CHUNK_BYTES,
  conversationCwd,
  readFileChunk,
  readFileForPayload,
  resolveReadPath,
} from "../src/main/engine/file-chunk.ts";

function fixture(): string {
  return mkdtempSync(join(tmpdir(), "fv-chunk-"));
}

test("slices stitch back into the original bytes", async () => {
  const dir = fixture();
  const bytes = Buffer.from(Array.from({ length: 1000 }, (_, index) => index % 251));
  const file = join(dir, "blob.bin");
  writeFileSync(file, bytes);
  const parts: Buffer[] = [];
  let offset = 0;
  for (;;) {
    const chunk = await readFileChunk(file, offset, 300);
    assert.equal(chunk.size, 1000);
    assert.equal(chunk.offset, offset);
    const data = Buffer.from(chunk.data, "base64");
    parts.push(data);
    offset += data.length;
    if (chunk.eof) break;
  }
  assert.deepEqual(Buffer.concat(parts), bytes);
});

test("an empty file is one eof slice, and a read past the end is empty rather than an error", async () => {
  const dir = fixture();
  const file = join(dir, "empty.txt");
  writeFileSync(file, "");
  const empty = await readFileChunk(file, 0, 100);
  assert.deepEqual([empty.data, empty.eof, empty.size], ["", true, 0]);
  writeFileSync(file, "abc");
  const past = await readFileChunk(file, 10, 100);
  assert.deepEqual([past.data, past.eof], ["", true]);
});

test("a slice is never larger than the cap", async () => {
  const dir = fixture();
  const file = join(dir, "big.bin");
  writeFileSync(file, Buffer.alloc(MAX_CHUNK_BYTES * 2 + 5, 7));
  const chunk = await readFileChunk(file, 0, MAX_CHUNK_BYTES * 10);
  assert.equal(Buffer.from(chunk.data, "base64").length, MAX_CHUNK_BYTES);
  assert.equal(chunk.eof, false);
});

test("a directory, a missing file and bad numbers are refused", async () => {
  const dir = fixture();
  await assert.rejects(readFileChunk(dir, 0, 10));
  await assert.rejects(readFileChunk(join(dir, "nope"), 0, 10));
  const file = join(dir, "a.txt");
  writeFileSync(file, "a");
  await assert.rejects(readFileChunk(file, -1, 10));
  await assert.rejects(readFileChunk(file, 0.5, 10));
  await assert.rejects(readFileChunk(file, "0", 10));
});

test("a symlink is followed to the file it names", async () => {
  const dir = fixture();
  writeFileSync(join(dir, "real.txt"), "hello");
  symlinkSync(join(dir, "real.txt"), join(dir, "link.txt"));
  const chunk = await readFileChunk(join(dir, "link.txt"), 0, 100);
  assert.equal(Buffer.from(chunk.data, "base64").toString(), "hello");
});

test("a relative path is read from the chat's directory, and never from this process's", async () => {
  const dir = fixture();
  mkdirSync(join(dir, "out"));
  writeFileSync(join(dir, "out", "report.md"), "# hi");
  const snapshot = { conversations: [{ id: "c1", cwd: dir }] };
  const chunk = await readFileForPayload({ path: "out/report.md" }, () => conversationCwd(snapshot, "c1"));
  assert.equal(Buffer.from(chunk.data, "base64").toString(), "# hi");
  assert.throws(() => resolveReadPath("out/report.md", undefined), /./);
  await assert.rejects(readFileForPayload({ path: "out/report.md" }, () => conversationCwd(snapshot, "other")));
});

test("an absolute path does not consult the catalog", async () => {
  const dir = fixture();
  writeFileSync(join(dir, "x.txt"), "x");
  let asked = false;
  await readFileForPayload({ path: join(dir, "x.txt") }, () => {
    asked = true;
    return undefined;
  });
  assert.equal(asked, false);
  assert.throws(() => resolveReadPath("bad\0path", dir));
  assert.throws(() => resolveReadPath("  ", dir));
});
