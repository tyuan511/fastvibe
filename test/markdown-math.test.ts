import { test } from "node:test";
import assert from "node:assert/strict";
import { isInlineMathText } from "../src/renderer/src/lib/remark-strict-inline-math.ts";

/**
 * The single-dollar rule, pinned.
 *
 * This app is full of `$` that is not math — shell variables, config paths, prices —
 * and `remark-math`'s default reads every `$…$` pair as a formula, so a reply about
 * `$HOME` came out as a garbled equation. The plugin's whole job is telling those
 * apart, and every case below is one that has been seen in the wild or is one wrong
 * call away from a broken transcript.
 */

test("shell variables and config paths are not math", () => {
  // The shape remark-math actually hands over: `$HOME/.config 复制到 $XDG_CONFIG_HOME`.
  assert.equal(isInlineMathText("$HOME/.config 复制到 $XDG_CONFIG_HOME"), false);
  assert.equal(isInlineMathText("$PATH 和 $HOME"), false);
});

test("a price range is not math", () => {
  assert.equal(isInlineMathText("$5 到 $10"), false);
  assert.equal(isInlineMathText("$1.5M revenue"), false);
});

test("real inline math is kept", () => {
  assert.equal(isInlineMathText("$O(n\\log n)$"), true);
  assert.equal(isInlineMathText("$d_k$"), true);
  assert.equal(isInlineMathText("$x^2 + y^2 = 1$"), true);
});

test("whitespace inside the fences means prose, on either side", () => {
  assert.equal(isInlineMathText("$ x$"), false);
  assert.equal(isInlineMathText("$x $"), false);
});

test("a digit right after the closing fence means prose", () => {
  // `$5 and $10` paired greedily would otherwise read as math holding `5 and `.
  assert.equal(isInlineMathText("$x$", "1"), false);
  assert.equal(isInlineMathText("$x$", " "), true);
});

test("a doubled fence is display math and skips the single-dollar rules", () => {
  assert.equal(isInlineMathText("$$x$$"), true);
});

test("an empty run is nothing, not math", () => {
  assert.equal(isInlineMathText("$$"), false);
});
