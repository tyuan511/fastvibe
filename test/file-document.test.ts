import { test } from "node:test";
import assert from "node:assert/strict";
import { documentOutline, numericColumns, slugify, splitFrontmatter } from "../src/shared/file-document.ts";

/**
 * The file pane's Markdown document view reads two things off the source: the
 * frontmatter block and the heading outline. Both are pure, and both have a failure
 * mode that is invisible on screen — a dropped field, a contents entry that jumps
 * into a code block — so the rules are pinned here.
 */

test("frontmatter splits from the body and keeps every field", () => {
  const parsed = splitFrontmatter("---\ntitle: Hello\nstatus: draft\n---\n\n# Body\n");
  assert.ok(parsed);
  assert.equal(parsed.body, "\n# Body\n");
  assert.deepEqual(parsed.fields, [
    { key: "title", value: "Hello" },
    { key: "status", value: "draft" },
  ]);
});

test("a document without a frontmatter block is not confused with an empty one", () => {
  assert.equal(splitFrontmatter("# Just a heading\n"), null);
  const empty = splitFrontmatter("---\n---\nbody");
  assert.ok(empty);
  assert.deepEqual(empty.fields, []);
  assert.equal(empty.body, "body");
});

test("inline and dash lists become items, and the joined value is the display form", () => {
  const inline = splitFrontmatter('---\ntags: [a, "b c", d]\n---\nx')!;
  assert.deepEqual(inline.fields[0]!.items, ["a", "b c", "d"]);
  assert.equal(inline.fields[0]!.value, "a, b c, d");

  const dashed = splitFrontmatter("---\ntools:\n  - read\n  - write\n---\nx")!;
  assert.deepEqual(dashed.fields[0]!.items, ["read", "write"]);
});

test("quotes are stripped from scalars but a colon inside one survives", () => {
  const parsed = splitFrontmatter('---\ndescription: "A thing: with a colon"\n---\nx')!;
  assert.equal(parsed.fields[0]!.value, "A thing: with a colon");
});

test("a block scalar keeps its line breaks, a folded one joins them", () => {
  const literal = splitFrontmatter("---\nbody: |\n  one\n  two\n---\nx")!;
  assert.equal(literal.fields[0]!.value, "one\ntwo");
  const folded = splitFrontmatter("---\nbody: >\n  one\n  two\n---\nx")!;
  assert.equal(folded.fields[0]!.value, "one two");
});

test("a wrapped scalar continues the field above it rather than becoming a new one", () => {
  const parsed = splitFrontmatter("---\nsummary: first part\n  and the rest\n---\nx")!;
  assert.equal(parsed.fields.length, 1);
  assert.equal(parsed.fields[0]!.value, "first part and the rest");
});

test("the outline reads headings in order and skips fenced code", () => {
  const outline = documentOutline("# One\n\ntext\n\n## Two\n\n```sh\n# not a heading\n```\n\n### Three\n");
  assert.deepEqual(
    outline.map((entry) => [entry.depth, entry.text]),
    [
      [1, "One"],
      [2, "Two"],
      [3, "Three"],
    ],
  );
});

test("heading markup is stripped from the label but kept in the slug source", () => {
  const outline = documentOutline("## `npm run build` and **more**\n");
  assert.equal(outline[0]!.text, "npm run build and more");
  assert.equal(outline[0]!.slug, "npm-run-build-and-more");
});

test("repeated headings get distinct anchors so a jump cannot land on the wrong one", () => {
  const outline = documentOutline("# Setup\n\n# Setup\n\n# Setup\n");
  assert.deepEqual(
    outline.map((entry) => entry.slug),
    ["setup", "setup-1", "setup-2"],
  );
});

test("a heading with nothing but punctuation still gets a usable anchor", () => {
  assert.equal(slugify("!!!"), "");
  const outline = documentOutline("# !!!\n");
  assert.equal(outline[0]!.slug, "section");
});

test("a column is numeric only when every non-empty cell is a number", () => {
  // Data rows only: a header is a label, and would make every column a text column.
  const columns = numericColumns([
    ["a", "1", "x"],
    ["b", "2", "y"],
  ]);
  assert.deepEqual([...columns], [1]);
});

test("currency, separators, percent and a single-letter unit all still count as numeric", () => {
  const columns = numericColumns([
    ["$1,200", "3.5%", "12k"],
    ["$2,000", "4%", "9k"],
  ]);
  assert.deepEqual([...columns], [0, 1, 2]);
});

test("a two-letter unit is not read as a number with a suffix", () => {
  const columns = numericColumns([["12ms"], ["9ms"]]);
  assert.deepEqual([...columns], []);
});

test("an empty column is not numeric, so a blank column is not right-aligned", () => {
  const columns = numericColumns([["", "1"], ["", "2"]]);
  assert.deepEqual([...columns], [1]);
});
