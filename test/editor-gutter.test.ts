import assert from "node:assert/strict";
import { test } from "node:test";
import { gutterSpans } from "../src/renderer/src/lib/editor-gutter.ts";

const metrics = { lineHeight: 20, paddingTop: 12 };

test("the first screen starts at the editor's padding, not at 0", () => {
  const spans = gutterSpans(0, 40, 10, metrics, null, 0);
  assert.deepEqual(
    spans.map((span) => [span.index, span.top, span.height]),
    [
      [0, 12, 20],
      [1, 32, 20],
    ],
  );
});

test("scrolling moves numbers by the same amount as the text", () => {
  const spans = gutterSpans(32, 40, 100, metrics, null, 0);
  assert.equal(spans[0].index, 1);
  assert.equal(spans[0].top, 0);
  assert.equal(spans.at(-1)?.index, 2);
});

test("overscan keeps a line just outside the viewport", () => {
  const spans = gutterSpans(32, 40, 100, metrics, null, 1);
  assert.equal(spans[0].index, 0);
  assert.equal(spans[0].top, -20);
  assert.equal(spans.at(-1)?.index, 3);
});

test("a short file does not invent lines past the end", () => {
  const spans = gutterSpans(0, 400, 2, metrics, null, 2);
  assert.deepEqual(spans.map((span) => span.index), [0, 1]);
});

test("nothing is drawn for an empty viewport or a zero line height", () => {
  assert.deepEqual(gutterSpans(0, 0, 10, metrics), []);
  assert.deepEqual(gutterSpans(0, 40, 10, { lineHeight: 0, paddingTop: 12 }), []);
  assert.deepEqual(gutterSpans(0, 40, 0, metrics), []);
});

test("soft-wrapped lines keep their own heights", () => {
  const spans = gutterSpans(0, 40, 3, metrics, [30, 10, 20], 0);
  assert.deepEqual(
    spans.map((span) => [span.index, span.top, span.height]),
    [[0, 12, 30]],
  );
});

test("a wrapped line scrolled to the top of the viewport stays put", () => {
  const spans = gutterSpans(42, 40, 3, metrics, [30, 10, 20], 0);
  assert.deepEqual(
    spans.map((span) => [span.index, span.top]),
    [
      [1, 0],
      [2, 10],
    ],
  );
});

test("a measured height of 0 still occupies one line", () => {
  const spans = gutterSpans(0, 50, 2, metrics, [0, 20], 0);
  assert.equal(spans[0].height, 20);
  assert.equal(spans[1].top, 32);
});

test("heights that do not match the line count are refused", () => {
  assert.deepEqual(gutterSpans(0, 40, 3, metrics, [20, 20]), []);
});
