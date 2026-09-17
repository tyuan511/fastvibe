import { test } from "node:test";
import assert from "node:assert/strict";
import { parseDiff } from "../src/renderer/src/lib/diff.ts";

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
