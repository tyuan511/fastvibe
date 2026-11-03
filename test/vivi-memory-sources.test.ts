import assert from "node:assert/strict";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { botMemoryRefs, viviMemoryMaterial, viviMemorySources } from "../src/main/bot/memory/sources.ts";
import type { BotConversationMeta, BotInput, BotResult } from "../src/shared/bot.ts";

const meta = (id: string, role: "router" | "worker"): BotConversationMeta => ({ conversationId: id, role, owner: "vivi", creationKey: id, epoch: 1, paused: false, title: id, createdAt: 1, updatedAt: 1 });
const input = (id: string, extra: Partial<BotInput> = {}): BotInput => ({ id, conversationId: "router", epoch: 1, source: "user", text: "以后周报使用三段格式", status: "completed", createdAt: 10, completedAt: 20, ...extra });

test("只提炼已结束的人类输入与有归属的Worker报告，状态/转载/中断不充当知识", () => {
  const inputs = [input("human"), input("status", { intent: "status" }), input("report", { source: "report" }), input("queued", { status: "queued" }), input("aborted", { status: "uncertain" }), input("work", { conversationId: "worker", source: "router" }), input("answer", { conversationId: "worker", source: "answer" })];
  const result = (id: string, extra: Partial<BotResult> = {}): BotResult => ({ id, conversationId: "worker", inputId: "work", epoch: 1, status: "ready", summary: "通过验证", createdAt: 19, ...extra });
  const sources = viviMemorySources({ conversations: [meta("router", "router"), meta("worker", "worker")], inputs, results: [result("ready"), result("idle", { status: "idle" }), result("uncertain", { status: "uncertain" }), result("wrong", { epoch: 0 }), result("orphan", { inputId: "missing" })] });
  assert.deepEqual(new Set(sources.map((source) => source.id)), new Set(["input:human", "input:answer", "result:ready"]));
  assert.equal(sources.find((source) => source.id === "input:human")?.createdAt, 10, "遗忘截止使用原始输入时间，迟到收尾不能把旧材料伪装成新来源");
});

test("增量材料按真实SDK entry锚点隔离，跳过旧轮、注入记忆与报告自述", () => {
  const manager = SessionManager.inMemory("/tmp");
  manager.appendMessage({ role: "user", content: "旧的要求", timestamp: 1 });
  manager.appendMessage(fauxAssistantMessage("OLD_MATERIAL"));
  const beforeEntryId = manager.getLeafId()!;
  manager.appendMessage({ role: "user", content: "RAW_ATTACHMENT_METADATA", timestamp: 2 });
  manager.appendMessage(fauxAssistantMessage([fauxToolCall("bot_memory_read", { path: "MEMORY.md", marker: "ALREADY_MEMORY" })], { stopReason: "toolUse" }));
  manager.appendMessage({ role: "toolResult", toolCallId: "mem", toolName: "bot_memory_read", content: [{ type: "text", text: "ALREADY_MEMORY" }], isError: false, timestamp: 3 });
  manager.appendMessage(fauxAssistantMessage([fauxToolCall("bot_create_work", { requestId: "INTERNAL_ROUTING", title: "work", text: "INTERNAL_ROUTING" })], { stopReason: "toolUse" }));
  manager.appendMessage({ role: "toolResult", toolCallId: "routing", toolName: "bot_send_message", content: [{ type: "text", text: "INTERNAL_ROUTING" }], isError: false, timestamp: 3 });
  manager.appendMessage(fauxAssistantMessage([fauxToolCall("bash", { command: "pnpm test" })], { stopReason: "toolUse" }));
  manager.appendMessage({ role: "toolResult", toolCallId: "test", toolName: "bash", content: [{ type: "text", text: "12 tests passed; password=secret-value-123" }], isError: false, timestamp: 4 });
  const afterEntryId = manager.getLeafId()!;
  manager.appendMessage(fauxAssistantMessage("NEXT_ROUND"));
  const material = viviMemoryMaterial(input("work", { memoryBranch: { beforeEntryId, afterEntryId } }), manager.getBranch());
  assert.match(material, /12 tests passed/);
  assert.match(material, /pnpm test/);
  for (const forbidden of ["OLD_MATERIAL", "RAW_ATTACHMENT_METADATA", "ALREADY_MEMORY", "INTERNAL_ROUTING", "NEXT_ROUND", "secret-value-123"]) assert.equal(material.includes(forbidden), false, forbidden);
  assert.match(material, /REDACTED_SECRET/);
  assert.match(viviMemoryMaterial(input("no-anchor"), manager.getBranch()), /No persisted execution evidence/);
  assert.match(viviMemoryMaterial(input("missing", { memoryBranch: { afterEntryId: "gone" } }), manager.getBranch()), /no longer available/);
});

test("记忆引用限制目录、数量和范围，保留章节以便执行时定位最新文本", () => {
  assert.deepEqual(botMemoryRefs([{ path: "MEMORY.md", heading: "周报" }]), [{ path: "MEMORY.md", heading: "周报" }]);
  assert.equal(botMemoryRefs(undefined), undefined);
  for (const path of ["../MEMORY.md", "/tmp/MEMORY.md", "rollout_summaries/../MEMORY.md", "rollout_summaries/link.md/other", "other.txt"]) assert.throws(() => botMemoryRefs([{ path }]));
  assert.throws(() => botMemoryRefs(Array(4).fill({ path: "MEMORY.md" })));
  assert.throws(() => botMemoryRefs([{ path: "MEMORY.md", limit: 10000 }]));
});
