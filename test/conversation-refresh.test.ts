import { test } from "node:test";
import assert from "node:assert/strict";
import { createConversationRefresh } from "../src/renderer/src/lib/conversation-refresh.ts";
import type { ChatMessage, EngineSessionState, SessionStats } from "../src/shared/types.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const REMOTE_ID = "remote:srv_alpha:chat-1";

function fixture(activeId: string | null = REMOTE_ID) {
  const stats = deferred<SessionStats>();
  const state = deferred<EngineSessionState>();
  const messages = deferred<ChatMessage[]>();
  const calls: [string, string][] = [];
  const applied: unknown[] = [];
  const store = {
    activeId,
    setStats: (value: SessionStats) => { applied.push(["stats", value]); },
    setSession: (value: EngineSessionState) => { applied.push(["state", value]); },
    setMessages: (value: ChatMessage[], id: string) => { applied.push(["messages", value, id]); },
  };
  const api = createConversationRefresh({
    getStats(id) { calls.push(["stats", id]); return stats.promise; },
    getState(id) { calls.push(["state", id]); return state.promise; },
    getMessages(id) { calls.push(["messages", id]); return messages.promise; },
  }, () => store);
  const run = () => Promise.all([
    api.refreshStats(), api.reloadActiveState(), api.reloadActiveMessages(),
  ]);
  const settle = () => {
    stats.resolve({});
    state.resolve({ conversationId: REMOTE_ID, isStreaming: false });
    messages.resolve([]);
  };
  return { api, store, calls, applied, stats, state, messages, run, settle };
}

test("refreshes explicitly request the remote conversation, never the host's local active chat", async () => {
  const f = fixture();
  const pending = f.run();
  assert.deepEqual(f.calls, [["stats", REMOTE_ID], ["state", REMOTE_ID], ["messages", REMOTE_ID]]);
  f.settle();
  await pending;
  assert.deepEqual(f.applied, [
    ["stats", {}],
    ["state", { conversationId: REMOTE_ID, isStreaming: false }],
    ["messages", [], REMOTE_ID],
  ]);
});

test("all three late results are discarded after switching conversations", async () => {
  const f = fixture();
  const pending = f.run();
  f.store.activeId = "other";
  f.settle();
  await pending;
  assert.deepEqual(f.applied, []);
});

test("state must explicitly belong to the requested conversation", async () => {
  for (const conversationId of ["other", undefined]) {
    const f = fixture();
    const pending = f.api.reloadActiveState();
    f.state.resolve({ conversationId, isStreaming: false });
    await pending;
    assert.deepEqual(f.applied, []);
  }
});

test("empty hero makes no requests", async () => {
  const f = fixture(null);
  await f.run();
  assert.deepEqual(f.calls, []);
  assert.deepEqual(f.applied, []);
});

test("background request failures are silently ignored", async () => {
  const f = fixture();
  const pending = f.run();
  for (const request of [f.stats, f.state, f.messages]) request.reject(new Error("offline"));
  await pending;
  assert.deepEqual(f.applied, []);
});
