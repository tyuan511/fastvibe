import assert from "node:assert/strict";
import test from "node:test";
import { resolvePendingById, waitingFrom } from "../src/renderer/src/stores/session-reducer.ts";
import type { PermissionRequest } from "../src/shared/types.ts";

/**
 * Answering a parked prompt from a card that is not in that chat.
 *
 * The queue is per conversation and the id is global, and the store's removal used to look in
 * the active conversation only. From the 看板 that meant a click resolved nothing: the card
 * stayed in 等你, and the prompt behind it stayed parked on the engine — the one failure mode
 * this surface exists to make visible.
 */

const prompt = (id: string, conversationId: string): PermissionRequest => ({
  id,
  conversationId,
  method: "confirm",
});

test("a prompt is removed from the conversation that owns it, not the active one", () => {
  const pending = {
    a: [prompt("p-a", "a")],
    b: [prompt("p-b", "b")],
  };
  const next = resolvePendingById(pending, "p-b");
  assert.deepEqual(Object.keys(next), ["a"]);
  // The other chat's queue is untouched, and the input object is not mutated.
  assert.deepEqual(pending.b?.map((item) => item.id), ["p-b"]);
});

test("only the answered prompt leaves a queue of several, in order", () => {
  const pending = {
    a: [prompt("p1", "a"), prompt("p2", "a"), prompt("p3", "a")],
  };
  const next = resolvePendingById(pending, "p2");
  assert.deepEqual(next.a?.map((item) => item.id), ["p1", "p3"]);
});

test("an id that is not in the queue changes nothing and says so by identity", () => {
  const pending = { a: [prompt("p1", "a")] };
  assert.equal(resolvePendingById(pending, "nope"), pending);
  const empty = {};
  assert.equal(resolvePendingById(empty, "p1"), empty);
});

test("the last prompt of a conversation drops its bucket, and the waiting mark with it", () => {
  const pending = { a: [prompt("p1", "a")], b: [prompt("p2", "b")] };
  const next = resolvePendingById(pending, "p1");
  assert.equal("a" in next, false);
  assert.deepEqual(Object.keys(waitingFrom(next, { a: true, b: true })), ["b"]);
});

test("a queue emptied across two clicks leaves nobody marked waiting", () => {
  let pending = { a: [prompt("p1", "a")], b: [prompt("p2", "b")] };
  pending = resolvePendingById(pending, "p1");
  pending = resolvePendingById(pending, "p2");
  assert.deepEqual(pending, {});
  assert.deepEqual(waitingFrom(pending, { a: true, b: true }), {});
});
