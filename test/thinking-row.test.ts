import assert from "node:assert/strict";
import { test } from "node:test";
import { isProcessKind, thinkingIsBlank, thinkingTakesRow } from "../src/renderer/src/lib/thinking-row.ts";

test("a reasoning block with only whitespace is blank", () => {
  // The shape seen in real transcripts: a thinking block whose text is one space.
  assert.equal(thinkingIsBlank(""), true);
  assert.equal(thinkingIsBlank(" "), true);
  assert.equal(thinkingIsBlank("  \n\t "), true);
  assert.equal(thinkingIsBlank("\u00a0"), true);
});

test("reasoning that was actually written is not blank", () => {
  assert.equal(thinkingIsBlank("先看看这个函数是谁调用的。"), false);
  assert.equal(thinkingIsBlank(" \n 三个要求。"), false);
  assert.equal(thinkingIsBlank("0"), false);
});

test("a blank block keeps its row only while it is the live tail", () => {
  // 「正在思考」 is a true report of work in flight, before any token of the thought exists.
  assert.equal(thinkingTakesRow("", true), true);
  assert.equal(thinkingTakesRow(" ", true), true);
  // Once it ends there is nothing for 「思考 · N 秒」 to expand to.
  assert.equal(thinkingTakesRow("", false), false);
  assert.equal(thinkingTakesRow(" ", false), false);
});

test("written reasoning takes a row whether it is live or settled", () => {
  assert.equal(thinkingTakesRow("想想", true), true);
  assert.equal(thinkingTakesRow("想想", false), true);
});

test("only thinking, a single call and a folded batch are the run's process", () => {
  for (const kind of ["thinking", "tool", "group"]) assert.equal(isProcessKind(kind), true);
  // Prose is the answer, a model switch and a compaction are transcript-level rules.
  for (const kind of ["text", "model", "compact"]) assert.equal(isProcessKind(kind), false);
});
