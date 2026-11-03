import assert from "node:assert/strict";
import test from "node:test";
import { deriveBotProgress, isStatusQuestion, statusTextForProgress } from "../src/main/bot/bot-progress.ts";
import type { BotConversationMeta, BotInput } from "../src/shared/bot.ts";
const meta: BotConversationMeta = { conversationId: "worker", role: "worker", owner: "vivi", creationKey: "worker", epoch: 1, paused: false, createdAt: 1, updatedAt: 5, title: "发布记录" };
const input = (id: string, status: BotInput["status"], createdAt: number, extra: Partial<BotInput> = {}): BotInput => ({ id, status, createdAt, conversationId: "worker", source: "user", text: "工作", epoch: 1, ...extra });
test("当前epoch的新完成不会被旧失败或状态查询覆盖", () => {
 const inputs = [input("old", "running", 100, { epoch: 0 }), input("failed", "failed", 10), input("new", "completed", 20), input("status", "completed", 30, { intent: "status" })];
 const progress = deriveBotProgress(meta, inputs, [], [{ id: "r", conversationId: "worker", inputId: "new", epoch: 1, status: "ready", createdAt: 21 }]);
 assert.equal(progress.inputId, "new"); assert.equal(progress.phase, "completed");
});
test("正在执行的输入优先于新排队输入并保留开始时间", () => {
 const progress = deriveBotProgress(meta, [input("running", "running", 10, { startedAt: 12 }), input("next", "queued", 20)], [], []);
 assert.equal(progress.inputId, "running"); assert.equal(progress.startedAt, 12); assert.equal(progress.queuedCount, 1);
});
test("已结束但仍有pending问题保持waiting，blocked不冒充问题", () => {
 const inputs = [input("work", "completed", 10)];
 const attention = [{ id: "q", conversationId: "worker", epoch: 1, question: "受众？", status: "pending" as const, createdAt: 12 }];
 assert.equal(deriveBotProgress({ ...meta, paused: true }, inputs, attention, []).phase, "waiting");
 assert.equal(deriveBotProgress(meta, inputs, [], [{ id: "r", conversationId: "worker", inputId: "work", epoch: 1, status: "blocked", createdAt: 12 }]).phase, "failed");
});
test("纯文本结束只算idle，不伪装成完成", () => {
 assert.equal(deriveBotProgress(meta, [input("work", "completed", 10)], [], []).phase, "idle");
});
test("进度查询只匹配完整短句", () => {
 for (const text of ["现在到哪了？", "进度怎么样", "What is the status?"]) assert.equal(isStatusQuestion(text), true);
 for (const text of ["看进度并修改文档", "现在到哪了？顺便加个摘要", "what is the status of the API contract change and update it", ""]) assert.equal(isStatusQuestion(text), false);
});
test("终态展示最终结果而非旧工作文案，未确认完成不能被Router回合冒充成功", () => {
 const completed = input("work", "completed", 10, { completedAt: 50, progress: { phase: "working", text: "正在检查", updatedAt: 20 } });
 const result = { id: "r", conversationId: "worker", inputId: "work", epoch: 1, status: "failed" as const, summary: "链接校验失败，文档已保留", createdAt: 49 };
 const progress = deriveBotProgress(meta, [completed], [], [result]);
 assert.equal(progress.detail, result.summary);
 assert.equal(progress.updatedAt, 50);
 assert.match(statusTextForProgress([progress], [], true), /链接校验失败/);
 const unconfirmed = deriveBotProgress(meta, [completed], [], [{ ...result, status: "idle", summary: "已生成初稿" }]);
 const router = { ...unconfirmed, conversationId: "router", role: "router" as const, result: undefined, phase: "completed" as const, updatedAt: 60 };
 assert.match(statusTextForProgress([router, unconfirmed], [], true), /尚未确认完成/);
});

test("并行进度和待答问题同时展示，不能被等待问题遮蔽", () => {
 const progress = deriveBotProgress(meta, [input("work", "running", 10)], [], []);
 const attention = [{ id: "q", conversationId: "other", epoch: 1, question: "说明面向谁？", status: "pending" as const, createdAt: 12 }];
 const text = statusTextForProgress([progress], attention, true);
 assert.match(text, /发布记录/);
 assert.match(text, /说明面向谁/);
});

test("状态查询聚合真实Worker，Router空闲不隐藏工作", () => {
 const progress = deriveBotProgress(meta, [input("work", "running", 10)], [], []);
 assert.match(statusTextForProgress([progress], [], true), /发布记录/);
 assert.match(statusTextForProgress([progress], [], false), /working/);
});
