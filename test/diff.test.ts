import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { readFileSync } from "node:fs";
import { parseDiff } from "../src/renderer/src/lib/diff.ts";

const SRC = path.join(import.meta.dirname, "..", "src/renderer/src");

/**
 * `parseDiff` is the one renderer for every diff the app shows, and its whole job is
 * reading line numbers out of the diff *text* rather than counting rows. The failure
 * it was written to fix — a gutter showing an invented index beside pi's real number —
 * is invisible in a typecheck and easy to reintroduce, so the shapes it must tell
 * apart are pinned here.
 */

test("a unified diff takes its numbers from the hunk header", () => {
  const doc = parseDiff(["@@ -12,2 +12,3 @@", " context", "-old", "+new", "+added"].join("\n"));
  assert.equal(doc.rows[0].kind, "hunk");
  // The header itself carries no line of its own.
  assert.deepEqual(
    doc.rows.slice(1).map((row) => [row.kind, row.oldNumber, row.newNumber]),
    [
      ["context", 12, 12],
      ["removed", 13, undefined],
      ["added", undefined, 13],
      ["added", undefined, 14],
    ],
  );
});

test("pi's baked-in numbers are read without a hunk header", () => {
  // The edit tool bakes the file's own line number into each row and sends no headers.
  // The number field is padded so the bodies share a column, so a body keeps that
  // leading padding — the assertion is about which number lands in which gutter.
  const doc = parseDiff(["- 12   label: 'x'", "+ 12   label: 'y'", "  13   keep"].join("\n"));
  assert.equal(doc.numberWidth, 2);
  assert.deepEqual(
    doc.rows.map((row) => [row.kind, row.oldNumber, row.newNumber]),
    [
      ["removed", 12, undefined],
      ["added", undefined, 12],
      ["context", 13, 13],
    ],
  );
});

test("a hand-written fence with neither headers nor numbers renders unnumbered", () => {
  // What a model usually writes by hand: no way to know the real line numbers, so the
  // gutter is omitted rather than filled with guesses.
  const doc = parseDiff([" some context", "-gone", "+here"].join("\n"));
  assert.equal(doc.numberWidth, 0);
  assert.deepEqual(
    doc.rows.map((row) => [row.kind, row.oldNumber, row.newNumber]),
    [
      ["context", undefined, undefined],
      ["removed", undefined, undefined],
      ["added", undefined, undefined],
    ],
  );
});

test("hunk headers win over baked-looking rows", () => {
  // A real diff whose context line happens to look like pi's numbered row must not be
  // read as one: the header is authoritative.
  const doc = parseDiff(["@@ -1 +1 @@", "- 12   label: 'x'", "+ 12   label: 'y'"].join("\n"));
  assert.deepEqual(doc.rows[1].oldNumber, 1);
  assert.deepEqual(doc.rows[2].newNumber, 1);
});

test("file metadata rows are marked as meta, not content", () => {
  const doc = parseDiff(["diff --git a/x b/x", "index 1234..5678 100644", "--- a/x", "+++ b/x"].join("\n"));
  assert.deepEqual(doc.rows.map((row) => row.kind), ["meta", "meta", "meta", "meta"]);
});

test("pi's elision row is skipped rather than treated as content", () => {
  const doc = parseDiff(["- 12   a", "   ...", "- 20   b"].join("\n"));
  assert.equal(doc.rows[1].kind, "skip");
});

test("a removed line and an added line do not share a number", () => {
  // The two counters advance independently: a replacement is one line out, one line
  // in, and the next context row is where both have moved on to 14.
  const doc = parseDiff(["@@ -12,2 +12,2 @@", "-gone", "+here", " keep"].join("\n"));
  assert.deepEqual(
    doc.rows.slice(1).map((row) => [row.oldNumber, row.newNumber]),
    [
      [12, undefined],
      [undefined, 12],
      [13, 13],
    ],
  );
});

test("split rows align replacement blocks without borrowing lines across hunks", async () => {
  const { splitDiffRows, changedRange } = await import("../src/renderer/src/lib/diff.ts");
  const rows = splitDiffRows(parseDiff("@@ -1,3 +1,4 @@\n-old\n+new\n+extra\n keep\n end\n@@ -50 +51 @@\n-before\n+after").rows);
  assert.deepEqual(rows.map((row) => [row.left?.text, row.right?.text, row.header?.kind]), [
    [undefined, undefined, "hunk"], ["old", "new", undefined], [undefined, "extra", undefined], ["keep", "keep", undefined], ["end", "end", undefined], [undefined, undefined, "hunk"], ["before", "after", undefined],
  ]);
  assert.deepEqual(changedRange("const old = 1", "const new = 1"), [6, 9]);
  assert.deepEqual(changedRange("same", "same"), [4, 4]);
});

test("content beginning with diff header characters is still content inside a hunk", () => {
  const doc = parseDiff("--- a/x\n+++ b/x\n@@ -1,2 +1,2 @@\n--- value\n+++ value\n keep\n");
  assert.deepEqual(doc.rows.slice(3).map((row) => [row.kind, row.text, row.oldNumber, row.newNumber]), [
    ["removed", "-- value", 1, undefined], ["added", "++ value", undefined, 1], ["context", "keep", 2, 2],
  ]);
});

/**
 * A diff row is a `<code>` per line, and a ```diff fence is not a `<pre>` — so
 * `.chat-markdown :not(pre) > code` (the inline-code chip: rounded, `--code-inline-bg`,
 * 0.1em/0.35em padding) used to reach every row and wrap it in a grey box. On screen that
 * was a box inside a box: the row's own tint showed only as a rim around the chip, and the
 * chip's padding shifted the text off the gutter. The escape hatch is one class, and both
 * halves of it are invisible to a typecheck — drop the `:not(.diff-line)` and the chips
 * come back, drop the class from the row and the rule matches nothing.
 */
test("a diff row is not styled as inline code", () => {
  const css = readFileSync(path.join(SRC, "index.css"), "utf8");
  const view = readFileSync(path.join(SRC, "components/chat/diff-view.tsx"), "utf8");
  const inline = css.match(/\.chat-markdown :not\(pre\) > code([^{]*)\{([^}]*)\}/);
  assert.ok(inline, "the inline-code rule exists");
  assert.match(inline[1], /:not\(\.diff-line\)/, "the inline chip excludes a diff row");
  assert.match(inline[2], /background: var\(--code-inline-bg\)/);
  const rows = view.match(/<code className="[^"]*"/g) ?? [];
  assert.equal(rows.length, 2, "both the unified row and the split cell");
  for (const row of rows) assert.match(row, /diff-line/, "every diff row carries the class");
});

/**
 * The two gutter columns must be one width on every row, or the rule between the gutter
 * and the code steps in and out down the diff. They used to be `min-width` boxes with the
 * 1px `border-r` outside the calculation: a blank row sat at the floor, and a row with a
 * number grew to `2ch` + padding + that border, so the columns differed by a pixel exactly
 * on the rows next to a change. A floor can always be exceeded by content, so the fix is a
 * fixed width that counts the border, and `overflow-hidden` for a number wider than the box.
 */
test("both gutter columns are one width, border included", () => {
  const view = readFileSync(path.join(SRC, "components/chat/diff-view.tsx"), "utf8");
  const cell = view.match(/const GUTTER_CELL = "([^"]+)"/);
  const width = view.match(/const gutterWidth = .*;\n/);
  assert.ok(cell && width, "the shared cell class and width exist");
  assert.match(cell[1], /\bborder-r\b/, "the border is on the shared cell, not one column only");
  assert.match(cell[1], /overflow-hidden/);
  assert.match(width[0], /\{ width: /, "a fixed width — a floor can be exceeded by content");
  assert.match(width[0], /\+ 1px/, "the width counts the 1px border");
  assert.doesNotMatch(view, /minWidth:/, "no gutter column is a min-width box");
  // Both columns, and the split view's cells, go through the same helper.
  assert.equal((view.match(/style=\{gutterWidth\(width\)\}|style=\{size\}/g) ?? []).length, 3);
});
