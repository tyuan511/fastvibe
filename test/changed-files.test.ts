import { test } from "node:test";
import assert from "node:assert/strict";
import { collectChangedFiles, countPatch } from "../src/renderer/src/lib/changed-files.ts";
import type { ToolCallBlock } from "../src/shared/types.ts";

function tool(patch: Partial<ToolCallBlock> & Pick<ToolCallBlock, "id" | "name">): ToolCallBlock {
  return { status: "done", ...patch };
}

test("countPatch ignores unified headers and counts + / - lines", () => {
  const patch = ["--- a/x", "+++ b/x", "@@ -1,2 +1,3 @@", " context", "-old", "+new", "+added"].join("\n");
  assert.deepEqual(countPatch(patch), { added: 2, removed: 1 });
});

test("collectChangedFiles reads edit diffs, not the working tree", () => {
  const files = collectChangedFiles([
    tool({
      id: "1",
      name: "edit",
      args: { path: "src/a.ts" },
      details: { diff: "-old\n+new" },
    }),
  ]);
  assert.equal(files.length, 1);
  assert.equal(files[0].path, "src/a.ts");
  assert.equal(files[0].added, 1);
  assert.equal(files[0].removed, 1);
  assert.equal(files[0].diff, "-old\n+new");
});

test("collectChangedFiles accepts details.patch when diff is absent", () => {
  const files = collectChangedFiles([
    tool({
      id: "1",
      name: "edit",
      args: { path: "src/a.ts" },
      details: { patch: "+only" },
    }),
  ]);
  assert.equal(files[0].diff, "+only");
  assert.equal(files[0].added, 1);
});

test("collectChangedFiles prefers details.diff over details.patch", () => {
  const files = collectChangedFiles([
    tool({
      id: "1",
      name: "edit",
      args: { path: "src/a.ts" },
      details: { diff: "+from-diff", patch: "+from-patch" },
    }),
  ]);
  assert.equal(files[0].diff, "+from-diff");
});

test("collectChangedFiles synthesises an add-only diff for write content", () => {
  const files = collectChangedFiles([
    tool({
      id: "1",
      name: "write",
      args: { path: "src/new.ts", content: "one\ntwo\n" },
    }),
  ]);
  assert.equal(files[0].added, 2);
  assert.equal(files[0].removed, 0);
  assert.equal(files[0].diff, "+one\n+two");
});

test("collectChangedFiles aggregates two writes to the same path", () => {
  const files = collectChangedFiles([
    tool({
      id: "1",
      name: "edit",
      args: { path: "src/a.ts" },
      details: { diff: "+a" },
    }),
    tool({
      id: "2",
      name: "edit",
      args: { path: "src/a.ts" },
      details: { diff: "-b" },
    }),
  ]);
  assert.equal(files.length, 1);
  assert.equal(files[0].added, 1);
  assert.equal(files[0].removed, 1);
  assert.equal(files[0].diff, "+a\n-b");
});

test("collectChangedFiles skips running and failed tools", () => {
  const files = collectChangedFiles([
    tool({
      id: "1",
      name: "edit",
      status: "running",
      args: { path: "src/a.ts" },
      details: { diff: "+a" },
    }),
    tool({
      id: "2",
      name: "edit",
      status: "error",
      args: { path: "src/b.ts" },
      details: { diff: "+b" },
    }),
  ]);
  assert.deepEqual(files, []);
});

test("collectChangedFiles matches write/edit family aliases and path keys", () => {
  const files = collectChangedFiles([
    tool({
      id: "1",
      name: "write_file",
      args: { file_path: "src/a.ts", content: "x" },
    }),
    tool({
      id: "2",
      name: "str_replace",
      args: { target_file: "src/b.ts" },
      details: { diff: "-old\n+new" },
    }),
  ]);
  assert.equal(files.length, 2);
  assert.equal(files[0].path, "src/a.ts");
  assert.equal(files[1].path, "src/b.ts");
});
