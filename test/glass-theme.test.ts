import test from "node:test";
import assert from "node:assert/strict";
import { isGlassEnabled } from "../src/shared/glass.ts";

/**
 * 玻璃效果 is read on both sides of the window: Main turns the window's vibrancy on, the
 * renderer gives the theme translucent surfaces. They must agree, or the window is either
 * see-through under a solid page or blurred under surfaces that hide it — so both go
 * through `isGlassEnabled`, and what it says about a key that was never written matters as
 * much as what it says about one that was.
 */

test("a settings file that never wrote the key has glass on, like a fresh install", () => {
  assert.equal(isGlassEnabled({}), true);
});

test("only an explicit false turns it off", () => {
  assert.equal(isGlassEnabled({ glass: true }), true);
  assert.equal(isGlassEnabled({ glass: false }), false);
});

test("a malformed value reads as the default, as the renderer's normaliser does", () => {
  // The settings store drops a non-boolean `glass`, which then reads back as on; Main
  // reads the same file before that and must land on the same answer.
  assert.equal(isGlassEnabled({ glass: "no" }), true);
  assert.equal(isGlassEnabled({ glass: 0 }), true);
});
