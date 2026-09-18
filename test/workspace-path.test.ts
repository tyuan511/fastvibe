import { test } from "node:test";
import assert from "node:assert/strict";
import { displayPath, resolvePath } from "../src/renderer/src/lib/workspace-path.ts";

/**
 * Conversation-triggered previews used to hand the engine's relative path to
 * Main's `stat` unchanged. The file tree joins onto an absolute cwd, so the same
 * file opened from the tree and from a tool card disagreed — ENOENT in the
 * preview, the real file sitting next to it. These two functions are the
 * round-trip that keeps them in one spelling.
 */

test("a relative path is joined onto the conversation cwd", () => {
  assert.equal(resolvePath("src/renderer/src/mock/preview-data.ts", "/repo"), "/repo/src/renderer/src/mock/preview-data.ts");
  assert.equal(resolvePath("./src/a.ts", "/repo"), "/repo/src/a.ts");
  assert.equal(resolvePath("src/a.ts", "/repo/"), "/repo/src/a.ts");
  assert.equal(resolvePath("src/a.ts", "C:\\Users\\me\\repo"), "C:/Users/me/repo/src/a.ts");
});

test("an already-absolute path is left in place", () => {
  assert.equal(resolvePath("/repo/src/a.ts", "/repo"), "/repo/src/a.ts");
  assert.equal(resolvePath("/other/a.ts", "/repo"), "/other/a.ts");
  assert.equal(resolvePath("C:/Users/me/repo/src/a.ts", "C:/Users/me/repo"), "C:/Users/me/repo/src/a.ts");
  assert.equal(resolvePath("C:\\Users\\me\\repo\\src\\a.ts", "C:\\Users\\me\\repo"), "C:/Users/me/repo/src/a.ts");
});

test("without a cwd a relative path cannot be guessed", () => {
  assert.equal(resolvePath("src/a.ts"), "src/a.ts");
  assert.equal(resolvePath("src/a.ts", ""), "src/a.ts");
  assert.equal(resolvePath("  "), "");
});

test("displayPath is the inverse for files inside the workspace", () => {
  assert.equal(displayPath("/repo/src/a.ts", "/repo"), "src/a.ts");
  assert.equal(displayPath("src/a.ts", "/repo"), "src/a.ts");
  assert.equal(displayPath("/repo", "/repo"), ".");
  assert.equal(displayPath("/other/a.ts", "/repo"), "/other/a.ts");
  assert.equal(displayPath(resolvePath("src/a.ts", "/repo"), "/repo"), "src/a.ts");
  assert.equal(resolvePath(displayPath("/repo/src/a.ts", "/repo"), "/repo"), "/repo/src/a.ts");
});
