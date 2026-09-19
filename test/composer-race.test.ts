import assert from "node:assert/strict";
import test from "node:test";
import { canRestoreComposer, shouldQueueSubmission } from "../src/renderer/src/lib/composer-race.ts";

test("submission keeps its initial queue semantics across an async stop", () => {
  assert.equal(shouldQueueSubmission({ hasConversation: true, running: true, paused: false, hasQueuedItems: false }), true);
  assert.equal(shouldQueueSubmission({ hasConversation: true, running: false, paused: true, hasQueuedItems: true }), true);
  assert.equal(shouldQueueSubmission({ hasConversation: true, running: false, paused: false, hasQueuedItems: false }), false);
  assert.equal(shouldQueueSubmission({ hasConversation: false, running: true, paused: true, hasQueuedItems: true }), false);
});

test("an async composer reservation cannot overwrite newer input", () => {
  assert.equal(canRestoreComposer(4, 4), true);
  assert.equal(canRestoreComposer(5, 4), false);
  assert.equal(canRestoreComposer(undefined, 4), false);
});
