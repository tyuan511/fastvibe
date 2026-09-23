import { test } from "node:test";
import assert from "node:assert/strict";
import {
  clipSnippet,
  findMatch,
  splitHighlight,
  splitSnippetHighlight,
} from "../src/renderer/src/lib/search-highlight.ts";

/**
 * The palette marks the query inside what it prints, so a hit says *why* it is a hit.
 * These are the rules behind that mark: literal matching, case folding that never moves
 * an index, and a cap on how many runs one excerpt may mark.
 */

test("the parts always rebuild the original string", () => {
  const parts = splitHighlight("设置里的主题模式", "主题");
  assert.equal(parts.map((part) => part.text).join(""), "设置里的主题模式");
  assert.deepEqual(
    parts.map((part) => [part.text, part.match]),
    [
      ["设置里的", false],
      ["主题", true],
      ["模式", false],
    ],
  );
});

test("matching is case-insensitive without lowercasing what is printed", () => {
  const parts = splitHighlight("Fix the Retry banner", "retry");
  assert.deepEqual(parts.find((part) => part.match)?.text, "Retry");
});

test("a query with no hit is one unmarked run, not an empty list", () => {
  assert.deepEqual(splitHighlight("上下文用量", "zzz"), [{ text: "上下文用量", match: false }]);
});

test("an empty query leaves the text alone", () => {
  assert.deepEqual(splitHighlight("abc", "   "), [{ text: "abc", match: false }]);
  assert.deepEqual(splitHighlight("", "abc"), []);
});

test("every occurrence is marked up to the cap, and the tail is kept", () => {
  const parts = splitHighlight("a-b-c-d", "-", 2);
  assert.equal(parts.map((part) => part.text).join(""), "a-b-c-d");
  assert.equal(parts.filter((part) => part.match).length, 2);
  assert.equal(parts.at(-1)?.text, "c-d");
});

test("the dot is literal, because a find control is not a pattern", () => {
  const parts = splitHighlight("a.b", ".");
  assert.deepEqual(parts.find((part) => part.match)?.text, ".");
  // `aXb` must not match the query `.` — this is the whole point of not using a regex.
  assert.deepEqual(splitHighlight("aXb", "."), [{ text: "aXb", match: false }]);
});

test("a case fold that changes length degrades to plain text rather than shifting the mark", () => {
  // `İ`.toLowerCase() is two code units, so every index the folded haystack reports sits
  // one character away from the original — a highlight drawn in the wrong place.
  const text = "İstanbul";
  assert.equal(text.toLowerCase().length !== text.length, true);
  assert.deepEqual(splitHighlight(text, "stan"), [{ text, match: false }]);
});

test("a snippet is folded onto one line before it is marked", () => {
  const parts = splitSnippetHighlight("line one\n   retry   the call", "retry");
  assert.deepEqual(
    parts.map((part) => [part.text, part.match]),
    [
      ["line one ", false],
      ["retry", true],
      [" the call", false],
    ],
  );
});

test("a snippet marks at most three runs, so a one-character query cannot paint the line", () => {
  const parts = splitSnippetHighlight("eeeeeeeee", "e");
  assert.equal(parts.filter((part) => part.match).length, 3);
  assert.equal(parts.map((part) => part.text).join(""), "eeeeeeeee");
});

test("clipSnippet keeps the match in view and admits what it cut", () => {
  const text = `${"前".repeat(60)}关键词${"后".repeat(60)}`;
  const clipped = clipSnippet(text, 60, "关键词");
  assert.equal(clipped.startsWith("…"), true);
  assert.equal(clipped.endsWith("…"), true);
  assert.equal(clipped.includes("关键词"), true);
  assert.equal(clipped.length < text.length, true);
});

test("clipSnippet leaves a short preview whole, with no ellipsis to explain", () => {
  const text = "retry the call";
  const clipped = clipSnippet(text, findMatch(text, "retry"), "retry");
  assert.equal(clipped, text);
});

test("findMatch reports where the same rule the search used puts the hit", () => {
  assert.equal(findMatch("设置里的主题模式", "主题"), 4);
  assert.equal(findMatch("设置里的主题模式", "ZZZ"), -1);
  assert.equal(findMatch("abc", ""), -1);
});
