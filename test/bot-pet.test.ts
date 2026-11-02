import assert from "node:assert/strict";
import test from "node:test";
import { ViviStateStore } from "../src/main/vivi/state.ts";
import { ViviCompletionState } from "../src/renderer/src/lib/vivi-completion.ts";
import type { BotDelivery } from "../src/shared/bot.ts";

const delivery: BotDelivery = { id: "delivery:1", conversationId: "worker-a", targetConversationId: "router", status: "delivered", text: "报告已经完成。", createdAt: 1 };

test("a completion animation returns to the latest work instead of hiding another task", () => {
  const state = new ViviStateStore({});
  state.follow([{ id: "a", label: "A", mood: "working", palette: "sky", conversationId: "a" }]);
  state.setMood("success", "a");
  state.follow([{ id: "b", label: "B", mood: "working", palette: "sky", conversationId: "b" }], true);
  assert.equal(state.state().mood, "success"); state.restoreActivity();
  assert.equal(state.state().mood, "working"); assert.equal(state.state().conversationId, "b");
  state.follow([]); assert.equal(state.state().mood, "idle");
});

test("an outstanding question takes priority over a success animation", () => {
  const state = new ViviStateStore({}); state.setMood("success", "done");
  state.follow([{ id: "q", label: "Q", mood: "waiting", palette: "sky", conversationId: "q" }], true);
  assert.equal(state.state().mood, "waiting"); state.restoreActivity(); assert.equal(state.state().conversationId, "q");
});

test("Bot delivery retains its conversation target when the Router starts another turn", () => {
  const state = new ViviCompletionState();
  assert.equal(state.deliver(delivery, true), true);
  state.event({ type: "conversation_running", conversationId: "router", running: true });
  assert.equal(state.completion?.conversationId, "worker-a"); assert.equal(state.completion?.text, delivery.text);
  assert.equal(state.deliver(delivery, true), false); assert.equal(state.completion?.revision, 1);
});

test("foreground deliveries are consumed and do not pop up when a duplicate arrives later", () => {
  const state = new ViviCompletionState(); assert.equal(state.deliver(delivery, false), false); assert.equal(state.deliver(delivery, true), false); assert.equal(state.completion, undefined);
});

test("a final Bot result supersedes an older asynchronous conversation read", () => {
  const state = new ViviCompletionState();
  const old = state.event({ type: "conversation_activity", conversationId: "chat", status: "completed" })!;
  state.deliver(delivery, true);
  assert.equal(state.accept(old, { conversationId: "chat", running: false, messages: [] }), false);
  assert.equal(state.completion?.conversationId, "worker-a");
});
