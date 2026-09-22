import { test } from "node:test";
import assert from "node:assert/strict";
import { splitMarkdownBlocks } from "../src/renderer/src/lib/markdown-blocks.ts";

/**
 * The transcript splits a streamed answer into independently parsed blocks so that a
 * long reply is parsed once instead of once per flush. Two things have to hold for that
 * to be safe: the text must survive the round trip exactly, and a structure that can
 * legally contain a blank line must never be cut in half.
 */

/** The property the whole optimisation rests on: nothing is added, lost or reordered. */
function assertLossless(text: string): string[] {
  const blocks = splitMarkdownBlocks(text);
  assert.equal(blocks.join("\n"), text);
  return blocks;
}

test("prose is split at blank lines, and every block keeps its own text", () => {
  const blocks = assertLossless("First paragraph.\n\nSecond paragraph.\n\nThird.");
  assert.equal(blocks.length, 3);
  assert.equal(blocks[0], "First paragraph.\n");
  assert.equal(blocks[2], "Third.");
});

test("a text with no blank line is left whole", () => {
  const text = "One line\nand another\n> quoted";
  assert.deepEqual(splitMarkdownBlocks(text), [text]);
});

test("a fenced code block containing blank lines is never cut", () => {
  const text = ["Before.", "", "```ts", "const a = 1;", "", "const b = 2;", "```", "", "After."].join("\n");
  const blocks = assertLossless(text);
  assert.equal(blocks.length, 3);
  assert.ok(blocks[1].startsWith("```ts"));
  assert.ok(blocks[1].includes("const b = 2;"));
});

test("a tilde fence, and a fence closed by a longer run, behave the same", () => {
  const text = ["~~~", "body", "", "more", "~~~~", "", "After."].join("\n");
  const blocks = assertLossless(text);
  assert.equal(blocks.length, 2);
  assert.ok(blocks[0].includes("more"));
});

test("an unterminated fence swallows the rest rather than splitting mid-code", () => {
  const text = ["```", "half a file", "", "still inside"].join("\n");
  assert.deepEqual(splitMarkdownBlocks(text), [text]);
});

test("a $$ math block spanning blank lines stays in one piece", () => {
  const text = ["Before.", "", "$$", "a = b", "", "c = d", "$$", "", "After."].join("\n");
  const blocks = assertLossless(text);
  assert.equal(blocks.length, 3);
  assert.ok(blocks[1].includes("c = d"));
  // A one-line `$$x$$` is already closed and must not open a fence.
  const inline = assertLossless("$$x = 1$$\n\nAfter.");
  assert.equal(inline.length, 2);
});

test("a loose list is one block, so its numbering cannot restart", () => {
  const text = ["1. first", "", "2. second", "", "3. third", "", "Done."].join("\n");
  const blocks = assertLossless(text);
  assert.equal(blocks.length, 2);
  assert.ok(blocks[0].includes("3. third"));
  assert.equal(blocks[1], "Done.");
});

test("blockquotes, tables and indented code are never cut at their blank lines", () => {
  const cases = [
    ["> quoted", "", "> still quoted"],
    ["| a |", "| --- |", "", "| b |"],
    ["    indented code", "", "    still code"],
  ];
  for (const lines of cases) {
    const text = ["Intro.", "", ...lines].join("\n");
    // Conservative on purpose: rather than risk cutting one of these in half, the
    // whole structure is kept with the block it follows.
    assert.deepEqual(assertLossless(text), [text], lines[0]);
  }
});

test("a link reference definition stays with the block above it", () => {
  const blocks = assertLossless("See [the docs][1].\n\n[1]: https://example.com\n");
  assert.equal(blocks.length, 1);
});

test("headings and thematic breaks do start a new block", () => {
  const blocks = assertLossless("Intro.\n\n## Heading\n\n---\n\nAfter.");
  assert.equal(blocks.length, 4);
  assert.equal(blocks[1], "## Heading\n");
  assert.equal(blocks[2], "---\n");
});

test("leading and trailing blank lines do not produce empty blocks", () => {
  const blocks = assertLossless("\n\nOnly paragraph.\n\n\n");
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0], "\n\nOnly paragraph.\n\n\n");
});

test("growing text keeps the settled blocks byte-identical", () => {
  // What the memoisation depends on: appending to the tail must not disturb any block
  // before it, or the components above would re-parse on every streamed flush.
  const settled = "Paragraph one.\n\nParagraph two.\n\n";
  let previous = splitMarkdownBlocks(`${settled}Partial`);
  for (const suffix of [" sentence", " sentence being", " sentence being written."]) {
    const next = splitMarkdownBlocks(`${settled}Partial${suffix}`);
    assert.deepEqual(next.slice(0, -1), previous.slice(0, -1));
    previous = next;
  }
});
