import assert from "node:assert/strict";
import test from "node:test";
import { botChatMessages } from "../src/renderer/src/lib/vivi-chat.ts";
import type { BotChatMessage } from "../src/shared/bot.ts";

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

test("独立消息通道不会把 Worker transcript 或内部交付混进 Vivi", () => {
  const messages: BotChatMessage[] = [{ id: "a", conversationId: "router", role: "assistant", text: "任务已更新。", createdAt: 1 }];
  assert.deepEqual(botChatMessages(messages).map((message) => message.text), ["任务已更新。"]);
});
