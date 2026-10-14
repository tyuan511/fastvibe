import assert from "node:assert/strict";
import { test } from "node:test";
import { applyFileMention, fileMentionAtCaret } from "../src/renderer/src/lib/file-mention.ts";

test("an @ at a token boundary is a file mention, an address is not", () => {
  assert.deepEqual(fileMentionAtCaret("@", 1), { start: 0, end: 1, query: "" });
  assert.deepEqual(fileMentionAtCaret("看一下@src/a", 9), { start: 3, end: 9, query: "src/a" });
  assert.equal(fileMentionAtCaret("user@host", 9), null);
  assert.equal(fileMentionAtCaret("a.b@c", 5), null);
  assert.equal(fileMentionAtCaret("hello @foo bar", 14), null);
  assert.deepEqual(fileMentionAtCaret("hello @foo bar", 10), { start: 6, end: 10, query: "foo" });
  assert.equal(fileMentionAtCaret("see @foo", 3), null);
});

test("picking a file removes the @ token without gluing or doubling spaces", () => {
  const mid = fileMentionAtCaret("fix @comp now", 9);
  assert.ok(mid);
  assert.deepEqual(applyFileMention("fix @comp now", mid), { value: "fix now", caret: 4 });

  const only = fileMentionAtCaret("@comp", 5);
  assert.ok(only);
  assert.deepEqual(applyFileMention("@comp", only), { value: "", caret: 0 });

  const lead = fileMentionAtCaret("@comp now", 5);
  assert.ok(lead);
  assert.deepEqual(applyFileMention("@comp now", lead), { value: "now", caret: 0 });

  const tail = fileMentionAtCaret("fix @comp", 9);
  assert.ok(tail);
  assert.deepEqual(applyFileMention("fix @comp", tail), { value: "fix", caret: 3 });
});
