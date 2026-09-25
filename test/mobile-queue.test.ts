import assert from "node:assert/strict";
import test from "node:test";
import { emptyQueue, mergeQueue, shouldQueueMessage, submitMessage, SubmissionUncertainError } from "../apps/mobile/src/chat/queue.ts";

const item = { id: "q-1", conversationId: "chat", text: "next", behavior: "followUp", sending: false, claimed: false };
function snapshot(revision: number, pause: "stopped" | "error" | null = null, items: unknown[] = [item]) {
  return { conversationId: "chat", revision, pause, items };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
function caller(settings: unknown = {}, queueReply: unknown = snapshot(1)) {
  const calls: { method: string; payload: unknown }[] = [];
  return {
    calls,
    async call(method: string, payload?: unknown) {
      calls.push({ method, payload });
      if (method === "settings:get") return settings;
      if (method === "engine:queue-add") return queueReply;
      if (method === "conversations:record-prompt") return { conversations: [{ id: "chat", title: "Chat", preview: "next" }] };
      return undefined;
    },
  };
}

test("mobile sends join an active run or an existing queue, including paused queues", () => {
  const idle = mergeQueue(emptyQueue("chat"), snapshot(0, null, []));
  assert.equal(shouldQueueMessage(false, idle), false);
  assert.equal(shouldQueueMessage(true, idle), true);
  for (const pause of [null, "stopped", "error"] as const) {
    assert.equal(shouldQueueMessage(false, mergeQueue(idle, snapshot(1, pause))), true);
  }
  // A stopped empty queue does not catch a fresh prompt.
  assert.equal(shouldQueueMessage(false, mergeQueue(idle, snapshot(2, "stopped", []))), false);
});

test("late snapshot/add/cancel/resume replies never resurrect delivered rows or an old pause", () => {
  let state = emptyQueue("chat");
  state = mergeQueue(state, snapshot(2, "stopped"));
  state = mergeQueue(state, snapshot(4, null, []));
  for (const oldReply of [snapshot(1), snapshot(2, "stopped"), snapshot(3)]) {
    assert.equal(mergeQueue(state, oldReply), state);
  }
  assert.equal(state.pause, null);
  assert.deepEqual(state.items, []);
});

test("malformed and other-conversation queue payloads cannot erase the current queue", () => {
  const state = mergeQueue(emptyQueue("chat"), snapshot(1));
  for (const invalid of [null, {}, { ...snapshot(5), conversationId: "other" },
    { ...snapshot(5), revision: NaN }, { ...snapshot(5), items: undefined },
    { ...snapshot(5), pause: "unknown" }, snapshot(5, null, [{ ...item, conversationId: "other" }]),
    snapshot(5, null, [{ id: "bad" }])]) {
    assert.equal(mergeQueue(state, invalid), state);
  }
});

test("reopening starts from a snapshot, including claimed rows and pause state", () => {
  const state = mergeQueue(emptyQueue("chat"), snapshot(12, "error", [{ ...item, claimed: true }]));
  assert.equal(state.pause, "error");
  assert.equal(state.items[0].claimed, true);
  assert.equal(state.revision, 12);
});

test("queued mobile submission calls queue-add, never prompt or optimistic transcript insertion", async () => {
  const remote = caller();
  const next = await submitMessage(remote, { conversationId: "chat", text: "next", enqueue: true }, () => assert.fail("queued prompt entered transcript"));
  assert.deepEqual(remote.calls.map((call) => call.method), ["conversations:record-prompt", "settings:get", "engine:queue-add"]);
  assert.deepEqual(remote.calls.at(-1)?.payload, { conversationId: "chat", text: "next", message: "next", behavior: "followUp", preview: undefined });
  assert.deepEqual(mergeQueue(emptyQueue("chat"), next).items, [Object.fromEntries(Object.entries(item).filter(([key]) => key !== "conversationId"))]);
});

test("queue choice survives a Stop while record-prompt is delayed", async () => {
  const recorded = deferred<unknown>();
  const remote = caller();
  let state = mergeQueue(emptyQueue("chat"), snapshot(1, null, []));
  const enqueue = shouldQueueMessage(true, state);
  const submission = submitMessage({ call(method, payload) {
    if (method === "conversations:record-prompt") return recorded.promise;
    return remote.call(method, payload);
  } }, { conversationId: "chat", text: "next", enqueue }, () => assert.fail("must remain queued"));
  state = mergeQueue(state, snapshot(2, "stopped", []));
  assert.equal(shouldQueueMessage(false, state), false);
  recorded.resolve({});
  await submission;
  assert.equal(remote.calls.at(-1)?.method, "engine:queue-add");
});

test("queue follows the host preference, but compact commands are never steered", async () => {
  for (const [text, behavior] of [["next", "steer"], ["/compact keep the plan", "followUp"]]) {
    const remote = caller({ queueBehavior: "steer" });
    await submitMessage(remote, { conversationId: "chat", text, enqueue: true }, () => assert.fail());
    assert.equal((remote.calls.at(-1)?.payload as { behavior: string }).behavior, behavior);
  }
});

test("direct submissions alone add an optimistic row and wait for prompt acceptance", async () => {
  const remote = caller();
  const acceptance = deferred<unknown>();
  let inserted = 0;
  const result = submitMessage({ call(method, payload) {
    if (method === "engine:prompt") return acceptance.promise;
    return remote.call(method, payload);
  } }, { conversationId: "chat", text: "next", enqueue: false }, () => inserted++);
  await Promise.resolve();
  assert.equal(inserted, 1);
  acceptance.resolve(undefined);
  assert.equal(await result, null);
  assert.equal(remote.calls.some((call) => call.method === "engine:queue-add"), false);
});

test("lost acknowledgements do not roll back an enqueue Main may have accepted", async () => {
  for (const message of ["请求超时", "连接已断开", "连接已关闭"]) {
    const remote = caller();
    await assert.rejects(submitMessage({ call(method, payload) {
      if (method === "engine:queue-add") return Promise.reject(new Error(message));
      return remote.call(method, payload);
    } }, { conversationId: "chat", text: "next", enqueue: true, previous: { title: "Chat", preview: "old" } }, () => assert.fail()), SubmissionUncertainError);
    assert.equal(remote.calls.some((call) => call.method === "conversations:restore-prompt"), false);
  }
});

test("queue removal can roll back the catalog preview and a refused enqueue reports failure", async () => {
  const remote = caller();
  const previous = { title: "Chat", preview: "old" };
  await submitMessage(remote, { conversationId: "chat", text: "next", enqueue: true, previous }, () => assert.fail());
  assert.deepEqual((remote.calls.at(-1)?.payload as { preview: unknown }).preview, {
    previousTitle: "Chat", previousPreview: "old", nextTitle: "Chat", nextPreview: "next",
  });
  await assert.rejects(submitMessage({ call(method, payload) {
    if (method === "engine:queue-add") return Promise.reject(new Error("disk full"));
    return remote.call(method, payload);
  } }, { conversationId: "chat", text: "next", enqueue: true, previous }, () => assert.fail()), /disk full/);
  assert.deepEqual(remote.calls.at(-1), { method: "conversations:restore-prompt", payload: {
    id: "chat", expectedTitle: "Chat", expectedPreview: "next", title: "Chat", preview: "old",
  } });
});
