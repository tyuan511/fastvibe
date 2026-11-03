import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, openDatabaseConnection, type Db } from "../src/main/engine/db.ts";
import { botChatMessages } from "../src/renderer/src/lib/vivi-chat.ts";
import { BotRuntime } from "../src/main/bot/bot-runtime.ts";
import { BotStore } from "../src/main/bot/bot-store.ts";
import type { BotChanged, BotExecutionOutcome, BotHost } from "../src/shared/bot.ts";

const done: BotExecutionOutcome = { status: "completed", text: "完成" };
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((yes) => { resolve = yes; }); return { promise, resolve }; }
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
async function until(check: () => boolean): Promise<void> { for (let i = 0; i < 300; i++) { if (check()) return; await tick(); } throw new Error("condition did not settle"); }
function withExternalProject<T extends object>(value: T, project: string): T { return { ...value, project } as T; }
function fixture(db: Db = openDatabase(":memory:")) {
  const store = new BotStore(db);
  const events: BotChanged[] = [];
  const calls: Array<Parameters<BotHost["execute"]>[0]> = [];
  let behavior: BotHost["execute"] = async () => done;
  const ids = new Map<string, string>();
  const resolvedProjects: string[] = [];
  const host: BotHost = {
    createConversation: async ({ kind, key }) => { const id = ids.get(key) ?? `${kind}:${ids.size + 1}`; ids.set(key, id); return { conversationId: id }; },
    execute: async (input) => { calls.push(input); return behavior(input); },
    snapshot: async (conversationId) => ({ conversationId, messages: [], running: false } as never),
    messages: async () => [], abort: async () => {},
    resolveProject: () => { resolvedProjects.push("/output"); return "/output"; },
    changed: (event) => events.push(event),
  };
  const runtime = new BotRuntime(store, host);
  return { db, store, runtime, host, events, calls, resolvedProjects, behavior: (fn: typeof behavior) => { behavior = fn; } };
}

 test("Vivi 忽略外部 project，Router 和 Worker 固定使用默认工作区", async () => {
  const f = fixture();
  try {
    f.runtime.start();
    await f.runtime.submit(withExternalProject({ requestId: "r1", text: "整理报告" }, "/project"));
    await f.runtime.submit(withExternalProject({ requestId: "r1", text: "整理报告" }, "bad"));
    assert.equal(f.store.conversations().length, 1);
    assert.equal(f.store.inputs().length, 1);
    assert.equal("project" in (f.store.input("r1") as object), false);
    assert.equal(f.resolvedProjects[0], "/output");
    await assert.rejects(f.runtime.submit({ requestId: "r1", text: "不同内容" }), /不同内容/);
    const worker = await f.runtime.createWork(withExternalProject({ requestId: "w1", title: "工作", text: "整理" }, "/other"));
    assert.equal(worker.project, "/output");
    assert.equal(f.resolvedProjects.at(-1), "/output");
    const restarted = new BotRuntime(new BotStore(f.db), f.host);
    await restarted.submit(withExternalProject({ requestId: "r1", text: "整理报告" }, "/another"));
    assert.equal(f.store.conversations().length, 2);
    await restarted.stop();
  } finally { await f.runtime.stop(); f.db.close(); }
});

test("Vivi 用户消息与 Router 回复写入独立 feed，路由给 Worker 的输入不进入 feed", async () => {
  const f = fixture();
  try {
    f.behavior(async (input) => {
      if (input.conversationId.startsWith("router:")) await f.runtime.reply({ conversationId: input.conversationId, text: "已安排任务。" });
      return done;
    });
    f.runtime.start();
    await f.runtime.submit({ requestId: "feed-user", text: "安排任务" });
    await until(() => f.store.input("feed-user")?.status === "completed");
    assert.deepEqual(f.store.chatMessages().map((message) => [message.role, message.text]), [["user", "安排任务"], ["assistant", "已安排任务。"]]);
    const worker = await f.runtime.createWork({ requestId: "feed-worker", title: "后台任务", text: "执行后台任务" });
    await f.runtime.routeMessage({ requestId: "feed-route", conversationId: worker.conversationId, text: "补充要求" });
    assert.equal(f.store.chatMessages().some((message) => message.text === "补充要求"), false);
  } finally { await f.runtime.stop(); f.db.close(); }
});

test("附件用户消息经数据库重开、snapshot 和聊天映射后仍完整，模型元数据不进入正文", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vivi-feed-attachments-"));
  const file = join(dir, "state.db");
  const f = fixture(openDatabaseConnection(file));
  const suffix = '\n\n<fastvibe-attachments>\n- /tmp/report.md\n</fastvibe-attachments>\n\n<fastvibe-pasted-text>\n[{"name":"notes.txt","content":"粘贴内容"}]\n</fastvibe-pasted-text>';
  const images = [{ type: "image" as const, mimeType: "image/png", data: "aW1hZ2U=" }];
  let reopened: Db | undefined;
  try {
    const mixed = { requestId: "mixed", text: `请看这些内容${suffix}`, images };
    const filesOnly = { requestId: "files-only", text: suffix };
    const imageOnly = { requestId: "image-only", text: "", images };
    for (const request of [mixed, filesOnly, imageOnly]) {
      await f.runtime.submit(request);
      await f.runtime.submit(request);
      assert.equal(f.store.input(request.requestId)?.text, request.text.trim());
      assert.deepEqual(f.store.input(request.requestId)?.images, request.images);
    }
    f.behavior(async () => ({ status: "completed", text: "" }));
    f.runtime.start();
    await until(() => f.store.inputs().every((input) => input.status === "completed"));
    assert.deepEqual(f.calls.map(({ text, images }) => ({ text, images })), [mixed, filesOnly, imageOnly].map(({ text, images }) => ({ text: text.trim(), images })));
    const before = await f.runtime.getWorkSnapshot();
    await f.runtime.stop();
    f.db.close();
    reopened = openDatabaseConnection(file);
    const restored = new BotRuntime(new BotStore(reopened), f.host);
    const snapshot = await restored.getWorkSnapshot();
    assert.deepEqual(snapshot.messages, before.messages);
    const visible = botChatMessages(snapshot.messages);
    assert.deepEqual(visible.map((message) => message.text), ["请看这些内容", "", ""]);
    assert.deepEqual(visible.map((message) => message.attachments?.length), [3, 2, 1]);
    assert.deepEqual(visible[0].attachments?.map((item) => [item.kind, item.name, item.path, item.text]), [
      ["file", "report.md", "/tmp/report.md", undefined],
      ["file", "notes.txt", undefined, "粘贴内容"],
      ["image", "image-1.png", undefined, undefined],
    ]);
    assert.equal(visible[0].attachments?.[2]?.dataUrl, "data:image/png;base64,aW1hZ2U=");
    assert.equal(visible[2].attachments?.[0]?.dataUrl, "data:image/png;base64,aW1hZ2U=");
    assert.ok(visible.every((message) => !message.parts?.some((part) => part.kind === "text" && part.text.includes("fastvibe-"))));
  } finally {
    await f.runtime.stop();
    if (reopened) reopened.close(); else f.db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Router 创建稳定 Worker，会话结果写入 outbox 并成功投递一次", async () => {
  const f = fixture();
  try {
    f.behavior(async (input) => {
      if (input.conversationId.startsWith("router:")) { await f.runtime.createWork(withExternalProject({ requestId: "w1", title: "报告", text: "写报告" }, "/project")); return done; }
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

test("activity 从消息入队到执行结束持续忙碌，不会在开始执行时误报空闲", async () => {
  for (const outcome of [done, { status: "failed", text: "", error: "upstream unavailable" } satisfies BotExecutionOutcome]) {
    const f = fixture();
    const execution = deferred<BotExecutionOutcome>();
    f.behavior(() => execution.promise);
    try {
      f.runtime.start();
      const snapshot = await f.runtime.submit({ requestId: "a", text: "你好" });
      assert.equal(snapshot.messages.at(-1)?.role, "user");
      await until(() => f.calls.length === 1);
      assert.equal(f.store.input("a")?.status, "running");
      const states = f.events.flatMap((event) => event.activity ? [event.activity.running] : []);
      const firstBusy = states.indexOf(true);
      assert.ok(firstBusy >= 0, "入队就应广播工作中");
      assert.ok(states.slice(firstBusy).every(Boolean), "queued → running 不能广播空闲");
      assert.equal(f.runtime.activity().running, true);
      execution.resolve(outcome);
      await until(() => !f.runtime.activity().running);
      assert.equal(f.events.at(-1)?.activity?.running, false);
      assert.equal(f.store.input("a")?.status, outcome.status === "completed" ? "completed" : "failed");
    } finally { execution.resolve(done); await f.runtime.stop(); f.db.close(); }
  }
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

test("图片输入跨 Runtime 重建保留附件且参与幂等校验", async () => {
  const f = fixture();
  let restarted: BotRuntime | undefined;
  const images = [{ type: "image" as const, mimeType: "image/png", data: "aW1hZ2U=" }];
  try {
    await f.runtime.submit(withExternalProject({ requestId: "image-only", text: "  ", images }, "/project"));
    await f.runtime.submit(withExternalProject({ requestId: "image-only", text: "", images }, "/project"));
    await assert.rejects(f.runtime.submit(withExternalProject({ requestId: "image-only", text: "", images: [{ ...images[0], data: "b3RoZXI=" }] }, "/project")), /不同内容/);
    await f.runtime.submit(withExternalProject({ requestId: "image-only", text: "", images }, "/other"));
    await assert.rejects(f.runtime.submit({ requestId: "empty", text: "", images: [] }), /消息不能为空/);
    await assert.rejects(f.runtime.submit({ requestId: "invalid", text: "图片", images: [{}] as never }), /图片附件格式无效/);
    const stored = new BotStore(f.db);
    assert.deepEqual(stored.input("image-only")?.images, images);
    assert.equal(stored.chatMessage("chat:user:image-only")?.text, "");
    assert.equal(stored.chatMessage("chat:user:image-only")?.attachments?.[0]?.dataUrl, "data:image/png;base64,aW1hZ2U=");
    restarted = new BotRuntime(stored, f.host);
    restarted.start();
    await until(() => stored.input("image-only")?.status === "completed");
    assert.deepEqual(f.calls[0].images, images);
    assert.equal(f.calls[0].text, "");
    assert.equal("project" in (f.calls[0] as object), false);
  } finally { await restarted?.stop(); await f.runtime.stop(); f.db.close(); }
});

test("每条 Router 输入都忽略外部 project 并使用默认工作区", async () => {
  const f = fixture();
  const gate = deferred<BotExecutionOutcome>();
  const seen: Array<string | undefined> = [];
  try {
    f.behavior(async (input) => {
      if (!input.conversationId.startsWith("router:")) return done;
      const context = f.runtime.contextFor(input.conversationId);
      assert.equal(context.input && "project" in context.input, false);
      seen.push(undefined);
      assert.equal(context.input?.requestId, input.requestId);
      if (input.requestId === "a") return gate.promise;
      await f.runtime.createWork(withExternalProject({ requestId: `work-${input.requestId}`, title: "整理项目", text: "整理这个项目" }, "/worker-project"));
      return done;
    });
    f.runtime.start();
    await f.runtime.submit(withExternalProject({ requestId: "a", text: "整理这个项目" }, "/project-a"));
    await until(() => seen.length === 1);
    await f.runtime.submit(withExternalProject({ requestId: "b", text: "整理这个项目" }, "/project-b"));
    await f.runtime.submit(withExternalProject({ requestId: "c", text: "整理默认输出目录" }, "/project-c"));
    assert.equal(f.runtime.contextFor(f.store.routerConversationId!).input && "project" in f.runtime.contextFor(f.store.routerConversationId!).input!, false);
    gate.resolve(done);
    await until(() => seen.length === 3);
    assert.deepEqual(seen, [undefined, undefined, undefined]);
    assert.equal("project" in (f.store.input("b") as object), false);
    assert.equal(f.store.conversationByKey("work:work-b")?.project, "/output");
    await until(() => Boolean(f.store.conversationByKey("work:work-c")));
    assert.equal(f.store.conversationByKey("work:work-c")?.project, "/output");
  } finally { gate.resolve(done); await f.runtime.stop(); f.db.close(); }
});

 test("自然语言后续输入可以继续同一个 Router 会话", async () => {
  const f = fixture(); try { f.runtime.start(); await f.runtime.submit({ requestId: "a", text: "第一条" }); await f.runtime.submit({ requestId: "b", text: "停止之前的工作" }); assert.equal(f.store.conversations()[0].role, "router"); assert.equal(f.store.inputs().length, 2); } finally { await f.runtime.stop(); f.db.close(); }
});

test("快捷进度查询不执行模型、不恢复暂停且重复请求不新增消息", async () => {
  const f = fixture();
  try {
    await f.runtime.submit({ requestId: "first", text: "写报告" });
    await f.runtime.stopAll();
    const routerId = f.store.routerConversationId!;
    const before = f.store.chatMessages().length;
    await f.runtime.submit({ requestId: "status", text: "现在到哪了？" });
    await f.runtime.submit({ requestId: "status", text: "现在到哪了？" });
    assert.equal(f.store.chatMessages().length, before + 2);
    assert.equal(f.store.chatMessages().at(-1)?.kind, "status");
    assert.equal(f.store.conversation(routerId)?.paused, true);
    assert.equal(f.calls.length, 0);
    assert.equal(f.store.input("status")?.intent, "status");
  } finally { await f.runtime.stop(); f.db.close(); }
});

test("同一个Runtime停止后再启动会恢复中断状态，不把迟到完成当成功", async () => {
  const f = fixture();
  const gate = deferred<BotExecutionOutcome>();
  f.behavior((input) => { input.signal.addEventListener("abort", () => gate.resolve(done), { once: true }); return gate.promise; });
  try {
    f.runtime.start();
    await f.runtime.submit({ requestId: "restart", text: "工作" });
    await until(() => f.calls.length === 1);
    await f.runtime.stop();
    assert.equal(f.store.input("restart")?.status, "uncertain");
    f.runtime.start();
    assert.equal(f.store.conversations()[0].paused, true);
    assert.equal(f.runtime.activity().running, false);
    assert.equal(f.calls.length, 1);
  } finally { gate.resolve(done); await f.runtime.stop(); f.db.close(); }
});

test("重启后的显式继续处理已有结果并结算投递，不重新执行Worker", async () => {
  const f = fixture();
  try {
    await f.runtime.submit({ requestId: "original", text: "整理文档" });
    const router = f.store.routerConversationId!;
    f.store.putInput({ ...f.store.input("original")!, status: "completed" });
    const worker = await f.runtime.createWork({ requestId: "worker-input", title: "文档", text: "写文档" });
    f.store.putInput({ ...f.store.input("worker-input")!, status: "completed" });
    f.store.putResult({ id: "ready-result", conversationId: worker.conversationId, inputId: "worker-input", epoch: 0, status: "ready", summary: "文档已完成", artifacts: ["/output/guide.md"], createdAt: 10 });
    f.store.putDelivery({ id: "delivery:ready-result", conversationId: worker.conversationId, targetConversationId: router, resultId: "ready-result", status: "injected", text: "[Worker result ready] 文档已完成；产物 /output/guide.md", createdAt: 11 });
    f.store.putInput({ id: "delivery:ready-result", conversationId: router, epoch: 0, source: "report", text: "文档已完成", status: "running", createdAt: f.store.input("original")!.createdAt + 10 });
    f.runtime.start();
    assert.equal(f.store.conversation(router)?.paused, true);
    assert.equal(f.calls.length, 0, "恢复时不能自动重放");
    await f.runtime.continueConversation({ conversationId: router });
    await until(() => f.store.delivery("delivery:ready-result")?.status === "delivered");
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0].conversationId, router);
    assert.match(f.calls[0].text, /文档已完成/);
    assert.match(f.calls[0].text, /guide.md/);
    assert.equal(f.store.results(worker.conversationId).length, 1);
    assert.equal(f.store.conversations().length, 2);
  } finally { await f.runtime.stop(); f.db.close(); }
});

test("Router 最终回复落盘后收到停止，终态写入不能覆盖停止回执", async () => {
  const f = fixture();
  f.host.changed = (event) => {
    f.events.push(event);
    if (event.message) void f.runtime.stopConversation({ conversationId: event.message.conversationId });
  };
  try {
    f.runtime.start();
    await f.runtime.submit({ requestId: "stop-after-reply", text: "处理" });
    await until(() => f.store.conversations()[0]?.paused === true && !f.runtime.activity().running);
    assert.equal(f.store.input("stop-after-reply")?.status, "uncertain");
    assert.equal(f.store.conversations()[0].epoch, 1);
  } finally { await f.runtime.stop(); f.db.close(); }
});

test("同一用户请求跨工作会话的阶段汇报最多三条，并去重限频", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 100_000 });
  const f = fixture();
  const gate = deferred<BotExecutionOutcome>();
  f.behavior(() => gate.promise);
  try {
    f.runtime.start();
    await f.runtime.submit({ requestId: "root", text: "整理两份文档" });
    await until(() => f.calls.length === 1);
    const router = f.store.routerConversationId!;
    const worker = await f.runtime.createWork({ requestId: "child", title: "检查文档", text: "检查链接" });
    await until(() => f.calls.length === 2);
    const milestone = (conversationId: string, requestId: string, text: string) => f.runtime.progress({ conversationId, requestId, epoch: 0, phase: "working", text, milestone: true });
    await milestone(router, "root", "已收集文件清单");
    await milestone(worker.conversationId, "child", "已检查第一份文档");
    assert.equal(f.store.chatMessages().filter((item) => item.kind === "progress").length, 1, "过密消息不能刷屏");
    t.mock.timers.setTime(102_001);
    await milestone(worker.conversationId, "child", "已检查第二份文档");
    t.mock.timers.setTime(104_002);
    await milestone(router, "root", "已汇总检查结果");
    t.mock.timers.setTime(106_003);
    await milestone(worker.conversationId, "child", "已完成最后检查");
    const reports = f.store.chatMessages().filter((item) => item.kind === "progress");
    assert.equal(reports.length, 3);
    assert.ok(reports.every((item) => item.inputId === "root"));
  } finally { gate.resolve(done); await f.runtime.stop(); f.db.close(); }
});

test("进度里程碑不会吞掉最终回复，停止后的旧epoch回报无效", async () => {
  const f = fixture();
  const gate = deferred<BotExecutionOutcome>();
  f.behavior(() => gate.promise);
  try {
    f.runtime.start();
    await f.runtime.submit({ requestId: "work", text: "处理" });
    await until(() => f.calls.length === 1);
    const id = f.store.routerConversationId!;
    await f.runtime.progress({ conversationId: id, requestId: "work", epoch: 0, phase: "planning", text: "已核对文件清单", milestone: true });
    const revision = f.store.revision;
    await f.runtime.progress({ conversationId: id, requestId: "work", epoch: 0, phase: "planning", text: "已核对文件清单", milestone: true });
    assert.equal(f.store.revision, revision);
    assert.equal(f.store.chatMessages().filter((message) => message.kind === "progress").length, 1);
    gate.resolve(done);
    await until(() => !f.runtime.activity().running);
    assert.equal(f.store.chatMessages().at(-1)?.text, "完成");
    assert.equal(f.store.chatMessages().at(-1)?.kind, "message");
    await f.runtime.stopConversation({ conversationId: id });
    await assert.rejects(f.runtime.report({ conversationId: id, requestId: "work", epoch: 0, summary: "迟到结果", outcome: "ready" }), /回合已结束/);
    await assert.rejects(f.runtime.reply({ conversationId: id, requestId: "work", epoch: 0, text: "迟到回复" }), /回合已结束/);
    await f.runtime.progress({ conversationId: id, requestId: "work", epoch: 0, phase: "working", text: "迟到进度" });
    assert.equal(f.store.chatMessages().some((message) => /迟到/.test(message.text)), false);
  } finally { gate.resolve(done); await f.runtime.stop(); f.db.close(); }
});
