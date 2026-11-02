import assert from "node:assert/strict";
import { test } from "node:test";
import { openDatabase } from "../src/main/engine/db.ts";
import { BotRuntime } from "../src/main/bot/bot-runtime.ts";
import { BotStore } from "../src/main/bot/bot-store.ts";
import type { BotChanged, BotExecutionOutcome, BotHost } from "../src/shared/bot.ts";

const done: BotExecutionOutcome = { status: "completed", text: "完成" };
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((yes) => { resolve = yes; }); return { promise, resolve }; }
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
async function until(check: () => boolean): Promise<void> { for (let i = 0; i < 300; i++) { if (check()) return; await tick(); } throw new Error("condition did not settle"); }
function fixture() {
  const db = openDatabase(":memory:");
  const store = new BotStore(db);
  const events: BotChanged[] = [];
  const calls: Array<Parameters<BotHost["execute"]>[0]> = [];
  let behavior: BotHost["execute"] = async () => done;
  const ids = new Map<string, string>();
  const host: BotHost = {
    createConversation: async ({ kind, key }) => { const id = ids.get(key) ?? `${kind}:${ids.size + 1}`; ids.set(key, id); return { conversationId: id }; },
    execute: async (input) => { calls.push(input); return behavior(input); },
    snapshot: async (conversationId) => ({ conversationId, messages: [], running: false } as never),
    messages: async () => [], abort: async () => {},
    resolveProject: (project) => { if (project === "bad") throw new Error("not a project"); return project ?? "/output"; },
    changed: (event) => events.push(event),
  };
  const runtime = new BotRuntime(store, host);
  return { db, store, runtime, host, events, calls, behavior: (fn: typeof behavior) => { behavior = fn; } };
}

 test("会话提交幂等、稳定创建键和项目校验", async () => {
  const f = fixture();
  try {
    f.runtime.start();
    await f.runtime.submit({ requestId: "r1", text: "整理报告", project: "/project" });
    await f.runtime.submit({ requestId: "r1", text: "整理报告", project: "/project" });
    assert.equal(f.store.conversations().length, 1);
    assert.equal(f.store.inputs().length, 1);
    await assert.rejects(f.runtime.submit({ requestId: "r1", text: "不同内容" }), /不同内容/);
    await assert.rejects(f.runtime.submit({ requestId: "r2", text: "工作", project: "bad" }), /not a project/);
    const restarted = new BotRuntime(new BotStore(f.db), f.host);
    await restarted.submit({ requestId: "r1", text: "整理报告", project: "/project" });
    assert.equal(f.store.conversations().length, 1);
    await restarted.stop();
  } finally { await f.runtime.stop(); f.db.close(); }
});

test("Router 创建稳定 Worker，会话结果写入 outbox 并成功投递一次", async () => {
  const f = fixture();
  try {
    f.behavior(async (input) => {
      if (input.conversationId.startsWith("router:")) { await f.runtime.createWork({ requestId: "w1", title: "报告", text: "写报告", project: "/project" }); return done; }
      await f.runtime.report({ conversationId: input.conversationId, requestId: input.requestId, outcome: "ready", summary: "报告已写好", evidence: ["已检查"], artifacts: ["/project/report.md"] });
      return done;
    });
    f.runtime.start();
    await f.runtime.submit({ requestId: "u1", text: "请写报告" });
    await until(() => f.store.deliveries("delivered").length === 1);
    assert.equal(f.store.conversations().filter((item) => item.role === "worker").length, 1);
    assert.equal(f.calls.filter((item) => item.conversationId.startsWith("router:")).length, 2);
    assert.equal(f.events.filter((event) => event.delivery).length, 1);
    const before = f.store.deliveries().length;
    const restarted = new BotRuntime(new BotStore(f.db), f.host); restarted.start(); await tick();
    assert.equal(f.store.deliveries().length, before);
    await restarted.stop();
  } finally { await f.runtime.stop(); f.db.close(); }
});

test("提问会暂停当前会话，回答沿用 conversationId 并进入新 epoch", async () => {
  const f = fixture(); let attentionId = ""; let rounds = 0;
  try {
    f.behavior(async (input) => {
      rounds++;
      if (rounds === 1) { attentionId = (await f.runtime.ask({ conversationId: input.conversationId, requestId: input.requestId, question: "文件名？" })).id; return done; }
      assert.equal(input.conversationId, f.store.conversations()[0].conversationId);
      assert.match(input.text, /answer.md/); await f.runtime.report({ conversationId: input.conversationId, requestId: input.requestId, outcome: "ready", summary: "已完成" }); return done;
    });
    f.runtime.start(); await f.runtime.submit({ requestId: "q", text: "开始" });
    await until(() => Boolean(attentionId) && !f.runtime.activity().running);
    const before = f.store.conversations()[0].epoch;
    assert.equal(f.runtime.activity().waiting, true);
    await f.runtime.answer({ attentionId, answer: "answer.md" });
    await until(() => rounds === 2);
    assert.equal(f.store.conversations()[0].epoch, before + 1);
    assert.equal(f.store.attention(attentionId)?.status, "resolved");
  } finally { await f.runtime.stop(); f.db.close(); }
});

test("停止先使 epoch 失效，迟到执行结果不能复活会话", async () => {
  const f = fixture(); const gate = deferred<BotExecutionOutcome>();
  try {
    f.behavior(async (input) => { input.signal.addEventListener("abort", () => gate.resolve({ status: "interrupted", text: "" }), { once: true }); return gate.promise; });
    f.runtime.start(); await f.runtime.submit({ requestId: "stop", text: "长任务" });
    await until(() => f.calls.length === 1);
    const id = f.calls[0].conversationId; const epoch = f.store.conversation(id)!.epoch;
    await f.runtime.stopConversation({ conversationId: id });
    assert.equal(f.store.conversation(id)!.paused, true);
    assert.equal(f.store.conversation(id)!.epoch, epoch + 1);
    assert.equal(f.store.input("stop")?.status, "uncertain");
  } finally { gate.resolve({ status: "interrupted", text: "" }); await f.runtime.stop(); f.db.close(); }
});

test("continueConversation 创建恢复输入且不会复用旧 epoch", async () => {
  const f = fixture(); let calls = 0;
  try {
    f.behavior(async () => { calls++; return done; }); f.runtime.start(); await f.runtime.submit({ requestId: "c", text: "工作" }); await until(() => calls === 1);
    const id = f.store.conversations()[0].conversationId; await f.runtime.stopConversation({ conversationId: id });
    await f.runtime.continueConversation({ conversationId: id }); await until(() => calls === 2);
    const inputs = f.store.inputs(id); assert.ok(inputs.some((input) => input.source === "resume" && input.epoch === 2));
  } finally { await f.runtime.stop(); f.db.close(); }
});

test("恢复将 running 输入标成 uncertain 并暂停会话，不自动重放", async () => {
  const f = fixture();
  try {
    const now = Date.now();
    f.store.putConversation({ conversationId: "router:1", role: "router", owner: "vivi", creationKey: "router:vivi", epoch: 0, paused: false, createdAt: now, updatedAt: now });
    f.store.putInput({ id: "crashed", conversationId: "router:1", epoch: 0, source: "user", text: "未完成", status: "running", createdAt: now });
    f.store.recover();
    assert.equal(f.store.input("crashed")?.status, "uncertain"); assert.equal(f.store.conversation("router:1")?.paused, true);
    f.runtime.start(); await tick(); assert.equal(f.calls.length, 0);
  } finally { await f.runtime.stop(); f.db.close(); }
});

test("activity 只读取持久事实，不需要加载会话正文", async () => {
  const f = fixture(); const changed: BotChanged[] = []; f.host.changed = (event) => changed.push(event);
  try { f.runtime.start(); await f.runtime.submit({ requestId: "a", text: "你好" }); assert.equal(typeof f.runtime.activity().running, "boolean"); assert.ok(changed.some((event) => event.activity)); }
  finally { await f.runtime.stop(); f.db.close(); }
});

test("停止全部后新请求恢复 Router，重启与重复请求不重放旧工作", async () => {
  const f = fixture();
  let restarted: BotRuntime | undefined;
  try {
    await f.runtime.submit({ requestId: "old-router", text: "旧请求" });
    const worker = await f.runtime.createWork({ requestId: "old-worker", title: "工作", text: "旧工作" });
    const routerId = f.store.routerConversationId!;
    await f.runtime.stopAll();
    assert.ok(f.store.inputs().every((input) => input.status === "canceled"));
    restarted = new BotRuntime(new BotStore(f.db), f.host);
    restarted.start();
    await restarted.submit({ requestId: "old-router", text: "旧请求" });
    assert.equal(f.store.conversation(routerId)?.paused, true);
    await restarted.submit({ requestId: "new-router", text: "新任务" });
    await until(() => f.store.input("new-router")?.status === "completed");
    assert.equal(f.store.conversation(routerId)?.paused, false);
    assert.equal(f.store.conversation(worker.conversationId)?.paused, true);
    assert.equal(f.store.input("old-router")?.status, "canceled");
    assert.equal(f.store.input("old-worker")?.status, "canceled");
    assert.deepEqual(f.calls.map((call) => call.requestId), ["new-router"]);
    await assert.rejects(restarted.submit({ requestId: "worker-followup", conversationId: worker.conversationId, text: "补充" }), /会话已暂停/);
  } finally { await restarted?.stop(); await f.runtime.stop(); f.db.close(); }
});

test("图片输入跨 Runtime 重建保留附件，图片与项目均参与幂等校验", async () => {
  const f = fixture();
  let restarted: BotRuntime | undefined;
  const images = [{ type: "image" as const, mimeType: "image/png", data: "aW1hZ2U=" }];
  try {
    await f.runtime.submit({ requestId: "image-only", text: "  ", images, project: "/project" });
    await f.runtime.submit({ requestId: "image-only", text: "", images, project: "/project" });
    await assert.rejects(f.runtime.submit({ requestId: "image-only", text: "", images: [{ ...images[0], data: "b3RoZXI=" }], project: "/project" }), /不同内容/);
    await assert.rejects(f.runtime.submit({ requestId: "image-only", text: "", images, project: "/other" }), /不同内容/);
    await assert.rejects(f.runtime.submit({ requestId: "empty", text: "", images: [] }), /消息不能为空/);
    await assert.rejects(f.runtime.submit({ requestId: "invalid", text: "图片", images: [{}] as never }), /图片附件格式无效/);
    const stored = new BotStore(f.db);
    assert.deepEqual(stored.input("image-only")?.images, images);
    restarted = new BotRuntime(stored, f.host);
    restarted.start();
    await until(() => stored.input("image-only")?.status === "completed");
    assert.deepEqual(f.calls[0].images, images);
    assert.equal(f.calls[0].text, "");
    assert.equal(f.calls[0].project, "/project");
  } finally { await restarted?.stop(); await f.runtime.stop(); f.db.close(); }
});

test("每条 Router 输入使用自己的项目，排队选择不会污染当前上下文", async () => {
  const f = fixture();
  const gate = deferred<BotExecutionOutcome>();
  const seen: Array<string | undefined> = [];
  try {
    f.behavior(async (input) => {
      if (!input.conversationId.startsWith("router:")) return done;
      const context = f.runtime.contextFor(input.conversationId);
      seen.push(context.input?.project);
      assert.equal(context.input?.requestId, input.requestId);
      if (input.requestId === "a") return gate.promise;
      await f.runtime.createWork({ requestId: `work-${input.requestId}`, title: "整理项目", text: "整理这个项目" });
      return done;
    });
    f.runtime.start();
    await f.runtime.submit({ requestId: "a", text: "整理这个项目", project: "/project-a" });
    await until(() => seen.length === 1);
    await f.runtime.submit({ requestId: "b", text: "整理这个项目", project: "/project-b" });
    await f.runtime.submit({ requestId: "c", text: "整理默认输出目录" });
    assert.equal(f.runtime.contextFor(f.store.routerConversationId!).input?.project, "/project-a");
    gate.resolve(done);
    await until(() => seen.length === 3);
    assert.deepEqual(seen, ["/project-a", "/project-b", undefined]);
    assert.equal(f.store.input("b")?.project, "/project-b");
    assert.equal(f.store.conversationByKey("work:work-b")?.project, "/project-b");
    await until(() => Boolean(f.store.conversationByKey("work:work-c")));
    assert.equal(f.store.conversationByKey("work:work-c")?.project, "/output");
  } finally { gate.resolve(done); await f.runtime.stop(); f.db.close(); }
});

 test("自然语言后续输入可以继续同一个 Router 会话", async () => {
  const f = fixture(); try { f.runtime.start(); await f.runtime.submit({ requestId: "a", text: "第一条" }); await f.runtime.submit({ requestId: "b", text: "停止之前的工作" }); assert.equal(f.store.conversations()[0].role, "router"); assert.equal(f.store.inputs().length, 2); } finally { await f.runtime.stop(); f.db.close(); }
});
