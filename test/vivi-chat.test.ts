import assert from "node:assert/strict";
import test from "node:test";
import { botChatMessages, viviConversationMessages } from "../src/renderer/src/lib/vivi-chat.ts";
import type { BotChatMessage, BotExecutionError } from "../src/shared/bot.ts";
import type { ChatMessage } from "../src/shared/types.ts";

test("Vivi 主聊天只读取独立的 Router 用户消息通道", () => {
  const messages: BotChatMessage[] = [
    { id: "u1", conversationId: "router", role: "user", text: "帮我整理项目", inputId: "u1", createdAt: 1 },
    { id: "a1", conversationId: "router", role: "assistant", text: "已安排 Worker 处理。", inputId: "u1", createdAt: 2 },
  ];
  const visible = botChatMessages(messages);
  assert.deepEqual(visible.map((message) => message.text), ["帮我整理项目", "已安排 Worker 处理。"]);
  assert.deepEqual(visible.map((message) => message.tools), [[], []]);
  assert.deepEqual(visible.map((message) => message.parts), [[{ kind: "text", text: "帮我整理项目" }], [{ kind: "text", text: "已安排 Worker 处理。" }]]);
});

test("Vivi 主聊天保留用户附件并只显示清理后的文字", () => {
  const messages: BotChatMessage[] = [{
    id: "u-image",
    conversationId: "router",
    role: "user",
    text: "",
    attachments: [{ id: "image:1:0", kind: "image", name: "image-1.png", mimeType: "image/png", dataUrl: "data:image/png;base64,aW1hZ2U=" }],
    createdAt: 1,
  }];
  const [visible] = botChatMessages(messages);
  assert.equal(visible.text, "");
  assert.deepEqual(visible.attachments, messages[0].attachments);
});

test("独立消息通道不会把 Worker transcript 或内部交付混进 Vivi", () => {
  const messages: BotChatMessage[] = [{ id: "a", conversationId: "router", role: "assistant", text: "任务已更新。", createdAt: 1 }];
  assert.deepEqual(botChatMessages(messages).map((message) => message.text), ["任务已更新。"]);
});


test("Router 执行失败留在对应消息位置，Worker 失败与成功交付不混入主聊天", () => {
  const result = (id: string, conversationId: string, status: "failed" | "ready", createdAt: number): BotChatMessage => ({
    id, conversationId, inputId: `input:${id}`, role: "assistant", kind: "result", text: `${id} detail`, createdAt,
    result: { id, conversationId, inputId: `input:${id}`, epoch: 0, status, summary: `${id} detail`, createdAt },
  });
  const source: BotChatMessage[] = [
    { id: "u", conversationId: "router", role: "user", text: "整理方案", createdAt: 1 },
    result("worker-ready", "worker", "ready", 2),
    result("router-failed", "router", "failed", 3),
    { id: "u2", conversationId: "router", role: "user", text: "新的要求", createdAt: 4 },
    result("worker-failed", "worker", "failed", 5),
  ];
  const mapped = botChatMessages(source, "router");
  assert.deepEqual(mapped.map((item) => item.id), ["u", "router-failed", "u2"]);
  assert.equal(mapped[1].role, "system");
  assert.equal(mapped[1].error, "router-failed detail");
  assert.equal(mapped[1].bot?.inputId, "input:router-failed");
  assert.equal(mapped[1].bot?.conversationId, "router");
  assert.deepEqual(botChatMessages([], "router"), [], "清空后不会从快照外复活错误行");
});

test("Worker 超时按实际失败呈现一次，保留已有文字和工具且不改写 SDK 消息", () => {
  const original: ChatMessage[] = [
    { id: "u", role: "user", text: "检查文档", tools: [], createdAt: 1 },
    { id: "a", role: "assistant", text: "已经读取文档", tools: [], stop: "aborted", createdAt: 2 },
  ];
  const failure: BotExecutionError = { conversationId: "worker", inputId: "input", error: "Vivi execution timed out", startedAt: 1, createdAt: 3 };
  const mapped = viviConversationMessages(original, failure);
  assert.equal(mapped.length, 3);
  assert.equal(mapped[1].text, original[1].text);
  assert.equal(mapped[1].stop, undefined);
  assert.equal(mapped[2].error, failure.error);
  assert.equal(mapped[2].bot?.inputId, "input");
  assert.equal(mapped[2].bot?.conversationId, "worker");
  assert.equal(original[1].stop, "aborted");
  assert.equal(viviConversationMessages(original), original);
});

test("SDK 已记录供应商错误时不额外重复显示同一错误", () => {
  const messages: ChatMessage[] = [{ id: "a", role: "assistant", text: "", tools: [], error: "503 overloaded", createdAt: 1 }];
  const mapped = viviConversationMessages(messages, { conversationId: "worker", inputId: "input", error: "503 overloaded", startedAt: 1, createdAt: 2 });
  assert.equal(mapped.filter((message) => message.error).length, 1);
  assert.equal(messages[0].error, "503 overloaded");
});

test("新请求在预检失败时保留上一轮错误，迟到错误不能覆盖更新的请求", () => {
  const messages: ChatMessage[] = [{ id: "old", role: "assistant", text: "", tools: [], error: "earlier failure", createdAt: 1 }];
  const failure: BotExecutionError = { conversationId: "worker", inputId: "new-input", error: "preflight failed", startedAt: 2, createdAt: 3 };
  const mapped = viviConversationMessages(messages, failure);
  assert.deepEqual(mapped.map((message) => message.error), ["earlier failure", "preflight failed"]);
  const newer = [...messages, { id: "new-user", role: "user" as const, text: "新要求", tools: [], createdAt: 4 }];
  assert.equal(viviConversationMessages(newer, failure), newer, "迟到的失败快照不应在新要求后追加旧错误");
});
