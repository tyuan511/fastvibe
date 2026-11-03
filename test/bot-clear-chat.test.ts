import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabaseConnection } from "../src/main/engine/db.ts";
import { BotStore } from "../src/main/bot/bot-store.ts";
import { BotRuntime } from "../src/main/bot/bot-runtime.ts";
import { viviMemorySources } from "../src/main/bot/memory/sources.ts";
import type { BotChanged, BotExecutionOutcome, BotHost } from "../src/shared/bot.ts";

function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((yes) => { resolve = yes; }); return { promise, resolve }; }
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
async function until(check: () => boolean) { for (let i = 0; i < 300; i++) { if (check()) return; await tick(); } throw new Error("condition did not settle"); }
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "vivi-clear-"));
  const path = join(root, "state.db");
  const db = openDatabaseConnection(path);
  const store = new BotStore(db);
  const calls: Parameters<BotHost["execute"]>[0][] = [];
  const events: BotChanged[] = [];
  let execute: BotHost["execute"] = async () => ({ status: "completed", text: "已处理" });
  let aborts = 0;
  const host: BotHost = {
    createConversation: async ({ kind, key }) => ({ conversationId: `${kind}:${key}` }),
    execute: async (input) => { calls.push(input); return execute(input); },
    snapshot: async (id) => ({ conversationId: id, running: false, messages: [{ id: "sdk-history", text: "原始 SDK 转写" }] } as never),
    messages: async () => [], resolveProject: () => root,
    changed: (event) => { events.push(event); }, abort: async () => { aborts++; },
  };
  const runtime = new BotRuntime(store, host);
  return { root, path, db, store, host, runtime, events, calls, get aborts() { return aborts; }, behavior: (fn: BotHost["execute"]) => { execute = fn; }, async close() { await runtime.stop(); db.close(); rmSync(root, { recursive: true, force: true }); } };
}

test("/clear 只清主聊天，跨连接与重开持久；工作、输入、结果、outbox、记忆来源及 SDK 转写保留", async () => {
  const f = fixture();
  try {
    await f.runtime.submit({ requestId: "user", text: "旧要求" });
    const worker = await f.runtime.createWork({ requestId: "work", text: "执行", title: "文档" });
    f.store.putChatMessage({ id: "reply", role: "assistant", conversationId: f.store.routerConversationId!, inputId: "user", kind: "message", text: "旧回复", createdAt: 2 });
    f.store.putChatMessage({ id: "milestone", role: "assistant", conversationId: worker.conversationId, kind: "progress", text: "阶段成果", createdAt: 3 });
    f.store.putChatMessage({ id: "legacy-status", role: "assistant", conversationId: worker.conversationId, kind: "status", text: "旧版状态消息", createdAt: 4 });
    f.store.putAttention({ id: "q", conversationId: worker.conversationId, epoch: 0, question: "哪个目录？", status: "pending", createdAt: 5 });
    f.store.putResult({ id: "r", conversationId: worker.conversationId, epoch: 0, status: "ready", summary: "文档完成", createdAt: 6 });
    f.store.putDelivery({ id: "d", conversationId: worker.conversationId, targetConversationId: f.store.routerConversationId!, status: "pending", text: "结果", resultId: "r", createdAt: 7 });
    const before = await f.runtime.getWorkSnapshot();
    const inputs = f.store.inputs();
    const sources = () => viviMemorySources({ conversations: f.store.conversations(), inputs: f.store.inputs(), results: f.store.results() });
    const memoryBefore = sources();
    const sdkBefore = await f.host.snapshot(worker.conversationId);
    const originalRows = f.store.chatMessages();
    const eventCount = f.events.length;
    const after = await f.runtime.clearChat();
    assert.deepEqual(after.messages, []);
    assert.equal(after.chatGeneration, 1);
    assert.equal(after.revision, before.revision + 1);
    for (const key of ["routerConversationId", "conversations", "attention", "results", "deliveries", "progress"] as const) assert.deepEqual(after[key], before[key], key);
    assert.deepEqual(f.store.inputs(), inputs);
    assert.deepEqual(f.store.chatMessages(), originalRows, "保留运行时去重依据，不会补回清掉的 reply");
    assert.deepEqual(sources(), memoryBefore);
    assert.deepEqual(await f.host.snapshot(worker.conversationId), sdkBefore);
    assert.equal(f.aborts, 0);
    assert.equal(f.calls.length, 0);
    assert.ok(f.events.slice(eventCount).every((event) => !event.message && !event.completion && !event.delivery), "只广播刷新，不产生消息或完成通知");
    const second = openDatabaseConnection(f.path);
    try { const store = new BotStore(second); assert.equal(store.chatGeneration, 1); assert.deepEqual(store.visibleChatMessages(), []); }
    finally { second.close(); }
    f.db.close();
    const reopened = openDatabaseConnection(f.path);
    try {
      const store = new BotStore(reopened);
      assert.deepEqual(store.visibleChatMessages(), []);
      const old = store.chatMessage("reply")!;
      store.putChatMessage(old);
      store.updateChatMessage({ ...old, text: "迟到的更新" });
      assert.deepEqual(store.visibleChatMessages(), [], "旧行更新/重复落盘不复活");
      store.putChatMessage({ id: "new", role: "assistant", conversationId: before.routerConversationId!, text: "新消息", createdAt: 0 });
      assert.deepEqual(store.visibleChatMessages().map((row) => row.text), ["新消息"], "不依赖时间戳，新消息正常可见");
    } finally { reopened.close(); }
  } finally { await f.close(); }
});

test("/clear 在 Router 运行中立即生效，已发出的回复不会被收尾重复补回，后续新回复正常显示", async () => {
  const f = fixture();
  const gate = deferred<BotExecutionOutcome>();
  try {
    f.behavior(async (input) => {
      await f.runtime.reply({ conversationId: input.conversationId, requestId: input.requestId, text: "已发出的回复" });
      return gate.promise;
    });
    f.runtime.start();
    await f.runtime.submit({ requestId: "u1", text: "执行" });
    await until(() => f.store.hasChatMessage("u1", "assistant", "message"));
    const active = f.store.inputs();
    const cleared = await f.runtime.submit({ requestId: "clear-command", text: " /clear\n" });
    assert.deepEqual(cleared.messages, []);
    assert.deepEqual(f.store.inputs(), active, "命令不入队也不结束当前运行");
    assert.equal(f.store.input("clear-command"), undefined);
    assert.equal(f.calls.length, 1);
    assert.equal(f.aborts, 0);
    gate.resolve({ status: "completed", text: "不要当作 fallback 重复写入" });
    await until(() => f.store.input("u1")?.status === "completed");
    assert.deepEqual((await f.runtime.getWorkSnapshot()).messages, []);
    f.behavior(async () => ({ status: "completed", text: "清空后的回答" }));
    await f.runtime.submit({ requestId: "u2", text: "继续问" });
    await until(() => f.store.input("u2")?.status === "completed");
    assert.deepEqual((await f.runtime.getWorkSnapshot()).messages.map((message) => message.text), ["继续问", "清空后的回答"]);
    assert.equal(f.calls[0].conversationId, f.calls[1].conversationId, "仍使用原 Router 上下文");
  } finally { gate.resolve({ status: "completed", text: "" }); await f.close(); }
});

test("清空前尚未写出的运行回复在清空后正常可见，旧快照保持旧 revision", async () => {
  const f = fixture();
  const gate = deferred<BotExecutionOutcome>();
  const preview = deferred<Record<string, { text: string; updatedAt: number }>>();
  try {
    f.behavior(() => gate.promise);
    f.runtime.start();
    await f.runtime.submit({ requestId: "u1", text: "执行" });
    await until(() => f.calls.length === 1);
    f.host.conversationPreviews = () => preview.promise;
    const stale = f.runtime.getWorkSnapshot();
    delete f.host.conversationPreviews;
    const cleared = await f.runtime.clearChat();
    gate.resolve({ status: "completed", text: "刚完成的新回复" });
    await until(() => f.store.input("u1")?.status === "completed");
    const fresh = await f.runtime.getWorkSnapshot();
    preview.resolve({});
    const old = await stale;
    assert.ok(old.revision < cleared.revision && cleared.revision < fresh.revision);
    assert.equal(old.chatGeneration, 0);
    assert.deepEqual(cleared.messages, []);
    assert.deepEqual(fresh.messages.map((row) => row.text), ["刚完成的新回复"]);
  } finally { preview.resolve({}); gate.resolve({ status: "completed", text: "" }); await f.close(); }
});

test("空白 Vivi 也能 /clear；普通命令在 SDK 之前被拒绝，不建 Router/Worker、不留消息", async () => {
  const f = fixture();
  try {
    await f.runtime.submit({ requestId: "clear", text: "/clear" });
    for (const command of ["/goal", "/handoff 下一步", "/compact", "/skill:office", "/clear 带参数"]) {
      await assert.rejects(f.runtime.submit({ requestId: command, text: command }), /only supports|仅支持/);
    }
    assert.deepEqual(f.store.conversations(), []);
    assert.deepEqual(f.store.inputs(), []);
    assert.deepEqual(f.store.chatMessages(), []);
    assert.equal(f.calls.length, 0);
    assert.ok(f.events.every((event) => !event.message && !event.completion));
  } finally { await f.close(); }
});
