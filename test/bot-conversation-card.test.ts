import assert from "node:assert/strict";
import test from "node:test";
import { botConversationCards } from "../src/renderer/src/lib/bot-conversation-card.ts";
import type { BotConversationMeta, BotProgress, BotResult, WorkSnapshot } from "../src/shared/bot.ts";

const worker: BotConversationMeta = { conversationId: "worker", role: "worker", owner: "vivi", creationKey: "worker", epoch: 2, paused: false, createdAt: 1, updatedAt: 10, title: "工作会话" };
const progress: BotProgress = { conversationId: "worker", inputId: "new-input", role: "worker", phase: "working", startedAt: 20, updatedAt: 30, queuedCount: 0 };
const ready: BotResult = { id: "result", conversationId: "worker", inputId: "old-input", epoch: 1, status: "ready", summary: "上一轮完成的内容", createdAt: 15 };
function snapshot(patch: Partial<WorkSnapshot> = {}): WorkSnapshot {
  return { revision: 1, conversations: [worker], attention: [], results: [], deliveries: [], messages: [], ...patch };
}

test("卡片保留真实回复摘要；新请求不能继承旧结果的完成状态", () => {
  const data = snapshot({ progress: [progress], results: [ready], conversationPreviews: { worker: { text: "实际最新回复\n第二行", updatedAt: 40 } } });
  const card = botConversationCards(data)[0];
  assert.equal(card.preview, "实际最新回复 第二行");
  assert.equal(card.status, "working");
  assert.equal(card.updatedAt, 40);
  assert.equal(botConversationCards({ ...data, progress: [{ ...progress, phase: "idle" }] })[0].status, "idle");
});

test("问题、暂停、完成和未确认结果保留各自含义", () => {
  const currentReady = { ...ready, inputId: progress.inputId, epoch: worker.epoch };
  const data = snapshot({ progress: [{ ...progress, phase: "completed", result: currentReady }], results: [currentReady] });
  assert.equal(botConversationCards(data)[0].status, "completed");
  const paused = { ...data, conversations: [{ ...worker, paused: true }] };
  assert.equal(botConversationCards(paused)[0].status, "paused");
  const question = { id: "question", conversationId: worker.conversationId, epoch: worker.epoch, status: "pending" as const, question: "需要哪种格式？", createdAt: 50 };
  assert.equal(botConversationCards({ ...paused, attention: [question] })[0].status, "waiting");
  assert.equal(botConversationCards({ ...paused, attention: [{ ...question, epoch: 1 }] })[0].status, "paused");
  const unconfirmed = { ...currentReady, status: "idle" as const };
  assert.equal(botConversationCards(snapshot({ progress: [{ ...progress, phase: "idle", result: unconfirmed }], results: [unconfirmed] }))[0].status, "unconfirmed");
  const blocked = { ...currentReady, status: "blocked" as const };
  assert.equal(botConversationCards(snapshot({ progress: [{ ...progress, phase: "failed", result: blocked }], results: [blocked] }))[0].status, "blocked");
});

test("摘要和更新时间按会话隔离、按更新排序；无回复不拿进度冒充回复", () => {
  const other = { ...worker, conversationId: "other", creationKey: "other", updatedAt: 100 };
  const data = snapshot({ conversations: [{ ...worker, role: "router" }, other, worker], progress: [{ ...progress, detail: "进度说明" }], conversationPreviews: { other: { text: "另一条会话的回复", updatedAt: 110 } } });
  const cards = botConversationCards(data);
  assert.deepEqual(cards.map((item) => item.conversation.conversationId), ["other", "worker"]);
  assert.equal(cards[0].preview, "另一条会话的回复");
  assert.equal(cards[1].preview, "");
  assert.equal(cards[1].updatedAt, 30);
});

test("结果或进度不能冒充最新回复，缺失回复保持为空", () => {
  assert.equal(botConversationCards(snapshot({ results: [ready] }))[0].preview, "");
  assert.equal(botConversationCards(snapshot())[0].preview, "");
  assert.equal(botConversationCards(snapshot({ conversationPreviews: { worker: { text: "长".repeat(1000), updatedAt: 40 } } }))[0].preview.length, 400);
});
