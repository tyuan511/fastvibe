import assert from "node:assert/strict";
import test from "node:test";
import { canRestoreComposer, shouldQueueSubmission } from "../src/renderer/src/lib/composer-race.ts";

test("submission keeps queue semantics for an active run or existing queue", () => {
  assert.equal(shouldQueueSubmission({ hasConversation: true, running: true, pauseReason: null, hasQueuedItems: false }), true);
  assert.equal(shouldQueueSubmission({ hasConversation: true, running: false, pauseReason: "stopped", hasQueuedItems: true }), true);
  assert.equal(shouldQueueSubmission({ hasConversation: true, running: false, pauseReason: "error", hasQueuedItems: false }), true);
  assert.equal(shouldQueueSubmission({ hasConversation: true, running: false, pauseReason: null, hasQueuedItems: false }), false);
  assert.equal(shouldQueueSubmission({ hasConversation: false, running: true, pauseReason: "error", hasQueuedItems: true }), false);
});

test("a stopped run accepts a fresh prompt instead of parking it", () => {
  assert.equal(shouldQueueSubmission({ hasConversation: true, running: false, pauseReason: "stopped", hasQueuedItems: false }), false);
  // The renderer may still have the old running mark when Stop has completed.
  assert.equal(shouldQueueSubmission({ hasConversation: true, running: true, pauseReason: "stopped", hasQueuedItems: false, stopConfirmed: true }), false);
});

test("an async composer reservation cannot overwrite newer input", () => {
  assert.equal(canRestoreComposer(4, 4), true);
  assert.equal(canRestoreComposer(5, 4), false);
  assert.equal(canRestoreComposer(undefined, 4), false);
});
