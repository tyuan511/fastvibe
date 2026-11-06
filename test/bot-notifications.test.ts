import assert from "node:assert/strict";
import test from "node:test";
import { BotAttentionNotices, type BotAttentionState, type BotAttentionStateStore } from "../src/main/vivi/bot-notifications.ts";
import type { BotConversationMeta, BotAttention, BotResult, WorkSnapshot } from "../src/shared/bot.ts";

const conversation: BotConversationMeta = { conversationId: "worker-1", role: "worker", owner: "vivi", creationKey: "work:1", epoch: 1, paused: true, createdAt: 1, updatedAt: 2, title: "发布记录", project: "/tmp/project" };
const question: BotAttention = { id: "question", conversationId: conversation.conversationId, epoch: 1, question: "面向哪个读者？", status: "pending", createdAt: 2 };
const snapshot = (patch: Partial<WorkSnapshot> = {}): WorkSnapshot => ({ revision: 1, routerConversationId: "router", conversations: [conversation], attention: [question], results: [], deliveries: [], ...patch });

const options = { enabled: true, focused: true, viewingVivi: false };

test("Vivi questions notify while an ordinary conversation is focused, once per question", () => {
  const notices = new BotAttentionNotices();
  assert.deepEqual(notices.take(snapshot(), options).map((notice) => notice.conversationId), [conversation.conversationId]);
  assert.deepEqual(notices.take(snapshot(), options), []);
});

test("a question visible in Vivi is announced after leaving the app", () => {
  const notices = new BotAttentionNotices();
  assert.deepEqual(notices.take(snapshot(), { ...options, viewingVivi: true }), []);
  assert.equal(notices.take(snapshot(), { enabled: true, focused: false, viewingVivi: false }).length, 1);
});

test("resolved questions and healthy results never raise failure notifications", () => {
  const notices = new BotAttentionNotices();
  const clean = snapshot({ attention: [{ ...question, status: "resolved" }], results: [{ id: "ready", conversationId: conversation.conversationId, epoch: 1, status: "ready", summary: "已完成", createdAt: 3 }] });
  assert.deepEqual(notices.take(clean, { enabled: true, focused: false, viewingVivi: false }), []);
});

test("failed results have stable notification identity and honor the switch", () => {
  const notices = new BotAttentionNotices();
  const failed: BotResult = { id: "result-1", conversationId: conversation.conversationId, epoch: 1, status: "failed", summary: "执行失败", createdAt: 3 };
  const failedSnapshot = snapshot({ attention: [], results: [failed] });
  assert.deepEqual(notices.take(failedSnapshot, { enabled: false, focused: false, viewingVivi: false }), []);
  const visible = { enabled: true, focused: false, viewingVivi: false };
  assert.equal(notices.take(failedSnapshot, visible).length, 1);
  assert.equal(notices.take(failedSnapshot, visible).length, 0);
  assert.equal(notices.take(snapshot({ attention: [], results: [{ ...failed, id: "result-2" }] }), visible).length, 1);
});

function memoryStore(): BotAttentionStateStore & { state(): BotAttentionState | undefined } {
  let saved: BotAttentionState | undefined;
  return {
    load: () => saved,
    save: (state) => { saved = state; },
    state: () => saved,
  };
}

test("the first launch with persistence counts existing facts as announced, without a notice", () => {
  const store = memoryStore();
  const notices = new BotAttentionNotices(store);
  assert.deepEqual(notices.take(snapshot(), options), []);
  assert.deepEqual(store.state()?.announced, [question.id]);
});

test("a restart does not repeat announced facts, a new one still announces once", () => {
  const store = memoryStore();
  new BotAttentionNotices(store).take(snapshot(), options);
  const restarted = new BotAttentionNotices(store);
  assert.deepEqual(restarted.take(snapshot(), options), []);
  const withNew = snapshot({ attention: [question, { ...question, id: "question-2", question: "第二个问题" }] });
  assert.deepEqual(restarted.take(withNew, options).map((notice) => notice.id), ["question-2"]);
  assert.deepEqual(new BotAttentionNotices(store).take(withNew, options), []);
});

test("facts that leave the snapshot are dropped from the persisted state", () => {
  const store = memoryStore();
  const notices = new BotAttentionNotices(store);
  notices.take(snapshot(), options);
  assert.deepEqual(store.state()?.announced, [question.id]);
  notices.take(snapshot({ attention: [] }), options);
  assert.deepEqual(store.state()?.announced, []);
});
