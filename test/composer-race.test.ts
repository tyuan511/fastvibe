import assert from "node:assert/strict";
import test from "node:test";
import { canRestoreComposer, shouldQueueSubmission } from "../src/renderer/src/lib/composer-race.ts";

test("an existing queue captures every Send, idle or not", () => {
  for (const running of [true, false]) {
    for (const stopConfirmed of [true, false]) {
      assert.equal(shouldQueueSubmission({ hasConversation: true, running, hasQueuedItems: true, stopConfirmed }), true);
    }
  }
});

test("with an empty queue only a live run queues", () => {
  assert.equal(shouldQueueSubmission({ hasConversation: true, running: true, hasQueuedItems: false }), true);
  assert.equal(shouldQueueSubmission({ hasConversation: true, running: false, hasQueuedItems: false }), false);
  assert.equal(shouldQueueSubmission({ hasConversation: false, running: true, hasQueuedItems: true }), false);
  // Stop already confirmed: the stale running mark does not count as a live run.
  assert.equal(shouldQueueSubmission({ hasConversation: true, running: true, hasQueuedItems: false, stopConfirmed: true }), false);
});

test("an async composer reservation cannot overwrite newer input", () => {
  assert.equal(canRestoreComposer(4, 4), true);
  assert.equal(canRestoreComposer(5, 4), false);
  assert.equal(canRestoreComposer(undefined, 4), false);
});
