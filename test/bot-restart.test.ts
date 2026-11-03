import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, openDatabaseConnection, type Db } from "../src/main/engine/db.ts";
import { BotStore } from "../src/main/bot/bot-store.ts";
import { BotRuntime } from "../src/main/bot/bot-runtime.ts";
import type { BotConversationMeta, BotExecutionOutcome, BotHost, BotInput } from "../src/shared/bot.ts";

const done: BotExecutionOutcome = { status: "completed", text: "已检查" };
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
async function until(check: () => boolean) {
  for (let i = 0; i < 1000; i++) { if (check()) return; await tick(); }
  throw new Error("recovery did not settle");
}
function fixture(db: Db = openDatabase(":memory:")) {
  const store = new BotStore(db);
  const calls: Parameters<BotHost["execute"]>[0][] = [];
  const created: Parameters<BotHost["createConversation"]>[0][] = [];
  let execute: BotHost["execute"] = async () => done;
  const host: BotHost = {
    createConversation: async (input) => { created.push(input); return { conversationId: "router" }; },
    execute: async (input) => { calls.push(input); return execute(input); },
    abort: async () => {}, snapshot: async () => { throw new Error("unused"); }, messages: async () => [],
    resolveProject: () => "/workspace", changed: () => {},
  };
  const runtime = new BotRuntime(store, host);
  const meta = (id: string, extra: Partial<BotConversationMeta> = {}) => {
    const value: BotConversationMeta = { conversationId: id, role: id === "router" ? "router" : "worker", creationKey: id, owner: "vivi", epoch: 0, paused: false, createdAt: 1, updatedAt: 1, project: `/workspace/${id}`, ...extra };
    store.putConversation(value);
    if (id === "router") store.setRouterConversationId(id);
    return value;
  };
  const input = (id: string, conversationId: string, extra: Partial<BotInput> = {}) => {
    const value: BotInput = { id, conversationId, epoch: 0, source: "router", status: "running", text: `要求 ${id}`, createdAt: 1, ...extra };
    store.putInput(value); return value;
  };
  const inspect = () => store.inputs("router").filter((item) => item.restartTargets);
  return { db, store, runtime, host, calls, created, meta, input, inspect, behavior: (fn: BotHost["execute"]) => { execute = fn; } };
}

test("真实数据库重开后自动检查并恢复原 Worker，保留附件、工作区和后续排队要求", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vivi-restart-"));
  const path = join(dir, "state.db");
  const first = fixture(openDatabaseConnection(path));
  let reopened: ReturnType<typeof fixture> | undefined;
  try {
    first.meta("router");
    const worker = first.meta("worker");
    const images = [{ type: "image" as const, mimeType: "image/png", data: "aW1hZ2U=" }];
    const refs = [{ path: "MEMORY.md", heading: "要求" }];
    first.input("original", "worker", { images, memoryRefs: refs, rootInputId: "user-root" });
    first.input("followup", "worker", { status: "queued", createdAt: 2, text: "后续要求" });
    first.db.close();
    reopened = fixture(openDatabaseConnection(path));
    const f = reopened;
    f.behavior(async (input) => {
      if (input.conversationId === "router") {
        if (f.store.input(input.requestId)?.restartTargets) {
          assert.equal(f.calls.filter((call) => call.conversationId === "worker").length, 0, "先检查，再恢复");
          assert.match(input.text, /bot_read_context/);
          await f.runtime.continueConversation({ conversationId: "worker", callerConversationId: "router" });
        }
      } else {
        if (input.requestId !== "followup") {
          assert.match(input.text, /Inspect the existing conversation, actual workspace files and external effects first/);
          assert.match(input.text, /要求 original/);
          assert.deepEqual(input.images, images);
          const receipt = f.store.input(input.requestId)!;
          assert.equal(receipt.recoveryOf, "original");
          assert.equal(receipt.rootInputId, "user-root");
          assert.deepEqual(receipt.memoryRefs, refs);
        }
        await f.runtime.report({ conversationId: "worker", requestId: input.requestId, outcome: "ready", summary: "已完成", evidence: ["已有文件已核对"] });
      }
      return done;
    });
    f.runtime.start(); f.runtime.start();
    await until(() => f.store.input("followup")?.status === "completed" && f.store.deliveries("delivered").length === 2);
    assert.equal(f.inspect().length, 1);
    assert.equal(f.store.input("original")?.status, "uncertain", "原请求不被重新入队或伪造完成");
    assert.deepEqual(f.calls.filter((call) => call.conversationId === "worker").map((call) => call.requestId), ["resume:worker:1", "followup"]);
    assert.equal(f.created.length, 0);
    assert.equal(f.store.conversations().length, 2);
    assert.equal(f.store.conversation("worker")?.project, worker.project);
    await f.runtime.stop(); f.runtime.start();
    await tick(); await tick();
    assert.equal(f.inspect().length, 1, "完成后重启不再安排恢复检查");
  } finally {
    await reopened?.runtime.stop();
    reopened?.db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("检查会跳过主动停止、待答问题与终态结果，仅续跑被应用退出中断的 Worker", async () => {
  const f = fixture();
  try {
    f.meta("router");
    f.meta("crashed"); f.input("crashed-input", "crashed", { status: "accepted" });
    f.meta("stopped", { epoch: 1, paused: true }); f.input("stopped-input", "stopped", { status: "uncertain" });
    f.meta("waiting", { paused: true }); f.input("waiting-input", "waiting");
    f.store.putAttention({ id: "question", conversationId: "waiting", inputId: "waiting-input", epoch: 0, status: "pending", question: "哪种格式？", createdAt: 2 });
    for (const status of ["ready", "blocked", "failed"] as const) {
      f.meta(status); f.input(`${status}-input`, status);
      f.store.putResult({ id: `${status}-result`, conversationId: status, inputId: `${status}-input`, epoch: 0, status, summary: status, createdAt: 3 });
    }
    f.meta("completed"); f.input("completed-input", "completed", { status: "completed" });
    f.behavior(async (input) => {
      if (input.conversationId === "router") {
        for (const id of ["crashed", "stopped", "waiting", "ready", "blocked", "failed", "completed"]) await f.runtime.continueConversation({ conversationId: id, callerConversationId: "router" });
      }
      return done;
    });
    f.runtime.start();
    await until(() => f.store.input("resume:crashed:1")?.status === "completed" && !f.runtime.activity().running);
    assert.deepEqual(f.calls.filter((call) => call.conversationId !== "router").map((call) => call.conversationId), ["crashed"]);
    assert.equal(f.store.conversation("stopped")?.paused, true);
    assert.equal(f.store.attention("question")?.status, "pending");
    assert.equal(f.store.input("ready-input")?.status, "completed");
    assert.equal(f.store.input("blocked-input")?.status, "failed");
    assert.equal(f.store.conversation("blocked")?.paused, true);
    assert.equal(f.store.input("completed-input")?.status, "completed");
    await f.runtime.stop(); f.runtime.start(); await tick(); await tick();
    assert.equal(f.inspect().length, 1, "旧的 ready/blocked/failed 不反复触发恢复");
  } finally { await f.runtime.stop(); f.db.close(); }
});

test("恢复检查自身退出后再次启动会继续检查，不丢 Worker，也不重复旧请求", async () => {
  const f = fixture();
  try {
    f.meta("router"); f.meta("worker"); f.input("work", "worker");
    f.behavior((input) => new Promise((resolve) => input.signal.addEventListener("abort", () => resolve(done), { once: true })));
    f.runtime.start();
    await until(() => f.inspect()[0]?.status === "running");
    const oldCheck = f.inspect()[0].id;
    await f.runtime.stop();
    assert.equal(f.store.input(oldCheck)?.status, "uncertain");
    f.behavior(async () => done);
    f.runtime.start(); f.runtime.start();
    await until(() => f.store.input("resume:worker:1")?.status === "completed" && !f.runtime.activity().running);
    assert.equal(f.inspect().length, 2);
    assert.equal(f.store.input(oldCheck)?.status, "uncertain");
    assert.equal(f.calls.filter((call) => call.conversationId === "worker").length, 1);
    assert.equal(f.store.conversation("worker")?.restartRecovery, undefined);
  } finally { await f.runtime.stop(); f.db.close(); }
});

test("用户在检查期间停止 Worker 后，迟到的继续工具与收尾补偿都不能恢复它", async () => {
  const f = fixture();
  try {
    f.meta("router"); f.meta("worker"); f.input("work", "worker");
    f.behavior(async (input) => {
      assert.equal(input.conversationId, "router");
      await f.runtime.stopConversation({ conversationId: "worker" });
      await f.runtime.continueConversation({ conversationId: "worker", callerConversationId: "router" });
      return done;
    });
    f.runtime.start(); await until(() => f.inspect()[0]?.status === "completed");
    assert.equal(f.calls.length, 1);
    assert.equal(f.store.conversation("worker")?.paused, true);
    assert.equal(f.store.conversation("worker")?.restartRecovery, undefined);
    await f.runtime.stop(); f.runtime.start(); await tick();
    assert.equal(f.calls.length, 1);
  } finally { await f.runtime.stop(); f.db.close(); }
});

test("用户主动暂停 Router 时不偷偷唤醒它来恢复 Worker", async () => {
  const f = fixture();
  try {
    f.meta("router", { epoch: 1, paused: true }); f.input("router-old", "router", { status: "uncertain" });
    f.meta("worker"); f.input("work", "worker");
    f.runtime.start(); await tick();
    assert.equal(f.calls.length, 0);
    assert.equal(f.store.conversation("worker")?.paused, true);
    assert.ok(f.store.conversation("worker")?.restartRecovery);
  } finally { await f.runtime.stop(); f.db.close(); }
});

test("Worker 已完成但恢复检查未结束时退出，只恢复现有结果汇报", async () => {
  const f = fixture();
  try {
    f.meta("router"); f.meta("worker"); f.input("work", "worker");
    f.behavior(async (input) => {
      if (input.conversationId === "router") {
        await f.runtime.continueConversation({ conversationId: "worker", callerConversationId: "router" });
        return new Promise((resolve) => input.signal.addEventListener("abort", () => resolve(done), { once: true }));
      }
      await f.runtime.report({ conversationId: "worker", requestId: input.requestId, outcome: "ready", summary: "已有文件", artifacts: ["/workspace/report.md"] });
      return done;
    });
    f.runtime.start();
    await until(() => f.store.input("resume:worker:1")?.status === "completed");
    await f.runtime.stop();
    f.behavior(async (input) => { assert.equal(input.conversationId, "router"); assert.match(input.text, /已有文件/); return done; });
    f.runtime.start();
    await until(() => f.store.deliveries("delivered").length === 1);
    assert.equal(f.calls.filter((call) => call.conversationId === "worker").length, 1);
    assert.equal(f.store.results("worker").length, 1);
    assert.equal(f.store.inputs("router").filter((item) => item.status === "queued").length, 0);
  } finally { await f.runtime.stop(); f.db.close(); }
});

test("无 Router 的独立 Worker 也会创建稳定 Router 后恢复；创建期间 Stop 不会被迟到启动覆盖", async () => {
  for (const stopped of [false, true]) {
    const f = fixture();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    f.host.createConversation = async () => { await gate; return { conversationId: "router" }; };
    try {
      f.meta("worker"); f.input("work", "worker");
      f.runtime.start();
      if (stopped) await f.runtime.stopAll();
      release();
      if (stopped) { await tick(); await tick(); assert.equal(f.calls.length, 0); }
      else { await until(() => f.store.input("resume:worker:1")?.status === "completed"); assert.equal(f.store.conversations().length, 2); }
    } finally { release(); await f.runtime.stop(); f.db.close(); }
  }
});

test("等待问题跨重启后回答，先处理答案再执行保留下来的补充与附件", async () => {
  const f = fixture();
  try {
    f.meta("worker", { paused: true });
    f.input("asked-work", "worker", { status: "completed" });
    const images = [{ type: "image" as const, mimeType: "image/png", data: "aW1hZ2U=" }];
    f.input("queued-detail", "worker", { status: "queued", text: "额外检查这张图片", images, createdAt: 2 });
    f.store.putAttention({ id: "waiting-question", conversationId: "worker", inputId: "asked-work", epoch: 0, status: "pending", question: "格式？", createdAt: 3 });
    f.runtime.start(); await tick();
    assert.equal(f.calls.length, 0);
    assert.equal(f.runtime.activity().running, false);
    await f.runtime.answer({ attentionId: "waiting-question", answer: "Markdown" });
    await until(() => f.store.input("queued-detail")?.status === "completed" && !f.runtime.activity().running);
    assert.deepEqual(f.calls.map((input) => input.requestId), ["answer:waiting-question", "queued-detail"]);
    assert.equal(f.calls[0].text, "Markdown");
    assert.deepEqual(f.calls[1].images, images);
    assert.equal(f.store.input("queued-detail")?.epoch, 1);
  } finally { await f.runtime.stop(); f.db.close(); }
});

test("中断 Router 尚未派发的原请求与图片在检查再次退出后仍会自动接续", async () => {
  const f = fixture();
  try {
    f.meta("router");
    const images = [{ type: "image" as const, mimeType: "image/png", data: "aW1hZ2U=" }];
    f.input("undispatched", "router", { source: "user", text: "读取图片并整理报告", images, memoryRefs: [{ path: "MEMORY.md" }] });
    f.behavior((input) => new Promise((resolve) => input.signal.addEventListener("abort", () => resolve(done), { once: true })));
    f.runtime.start();
    await until(() => f.inspect()[0]?.status === "running");
    assert.deepEqual(f.calls[0].images, images);
    await f.runtime.stop();
    f.behavior(async (input) => { assert.match(input.text, /Original request:[\s\S]*读取图片并整理报告/); assert.deepEqual(input.images, images); return done; });
    f.runtime.start();
    await until(() => f.inspect().length === 2 && f.inspect()[1].status === "completed" && !f.runtime.activity().running);
    assert.equal(f.inspect()[1].rootInputId, "undispatched");
    assert.deepEqual(f.inspect()[1].memoryRefs, [{ path: "MEMORY.md" }]);
    assert.equal(f.store.input("undispatched")?.status, "uncertain");
  } finally { await f.runtime.stop(); f.db.close(); }
});

test("恢复后轮到较早入队的补充要求时再次退出，仍按实际执行输入恢复", async () => {
  for (const graceful of [false, true]) {
    const f = fixture();
    try {
      f.meta("router"); f.meta("worker", { epoch: 1 });
      f.input("previous-recovery", "worker", { epoch: 1, source: "resume", status: "completed", text: "已恢复原工作", createdAt: 100, startedAt: 100, completedAt: 150 });
      f.input("older-followup", "worker", { epoch: 1, status: graceful ? "uncertain" : "running", text: "继续处理补充要求", createdAt: 2, startedAt: 200, ...(graceful ? { completedAt: 201 } : {}) });
      f.runtime.start();
      await until(() => f.store.input("resume:worker:2")?.status === "completed" && !f.runtime.activity().running);
      assert.deepEqual(f.inspect()[0].restartTargets, [{ conversationId: "worker", epoch: 1, inputId: "older-followup" }]);
      const call = f.calls.find((item) => item.conversationId === "worker")!;
      assert.match(call.text, /继续处理补充要求/);
      assert.doesNotMatch(call.text, /已恢复原工作/);
    } finally { await f.runtime.stop(); f.db.close(); }
  }
});

test("检查失败后下次启动会重试恢复检查；已暂停队列不冒充运行中", async () => {
  const f = fixture();
  try {
    f.meta("router"); f.meta("worker"); f.input("work", "worker");
    f.behavior(async () => ({ status: "failed", text: "", error: "temporary unavailable" }));
    f.runtime.start();
    await until(() => f.inspect()[0]?.status === "failed" && !f.runtime.activity().running);
    assert.ok(f.store.conversation("worker")?.restartRecovery);
    await f.runtime.stop();
    f.behavior(async () => done);
    f.runtime.start();
    await until(() => f.store.input("resume:worker:1")?.status === "completed" && !f.runtime.activity().running);
    assert.equal(f.inspect().length, 2);
    assert.equal(f.calls.filter((call) => call.conversationId === "worker").length, 1);
    await f.runtime.stopConversation({ conversationId: "worker" });
    f.input("held", "worker", { epoch: 2, status: "queued" });
    assert.equal(f.runtime.activity().running, false, "暂停中的队列没有正在执行的工作");
  } finally { await f.runtime.stop(); f.db.close(); }
});

test("已持久排队但未开始的恢复检查重开后复用；停止后迟到的 Router 调用不能继续 Worker", async () => {
  const f = fixture();
  try {
    f.meta("router"); f.meta("worker"); f.input("work", "worker");
    f.runtime.start();
    const check = f.inspect()[0];
    assert.equal(check.status, "queued");
    await f.runtime.stop();
    f.behavior(async (input) => {
      if (input.conversationId === "router") {
        await f.runtime.stopConversation({ conversationId: "router" });
        await f.runtime.continueConversation({ conversationId: "worker", callerConversationId: "router", callerRequestId: input.requestId, callerEpoch: input.epoch });
      }
      return done;
    });
    f.runtime.start();
    await until(() => f.calls.length === 1 && !f.runtime.activity().running);
    assert.equal(f.inspect().length, 1, "使用原排队检查，不重复安排");
    assert.equal(f.store.conversation("worker")?.paused, true);
    assert.equal(f.store.input(check.id)?.status, "uncertain");
    await f.runtime.continueConversation({ conversationId: "worker", callerConversationId: "router", callerRequestId: check.id, callerEpoch: 0 });
    assert.equal(f.calls.length, 1, "调用方已结束时仍不能继续");
  } finally { await f.runtime.stop(); f.db.close(); }
});

test("应用正常退出发生在 Worker 已报告 ready 后，已有结果不被中断兜底覆盖", async () => {
  const f = fixture();
  try {
    f.meta("router"); f.meta("worker"); f.input("work", "worker", { status: "queued" });
    f.behavior(async (input) => {
      if (input.conversationId !== "worker") return done;
      await f.runtime.report({ conversationId: "worker", requestId: input.requestId, outcome: "ready", summary: "确实已完成" });
      return new Promise((resolve) => input.signal.addEventListener("abort", () => resolve(done), { once: true }));
    });
    f.runtime.start(); await until(() => f.store.results("worker").length === 1);
    await f.runtime.stop();
    assert.equal(f.store.results("worker")[0].status, "ready");
    f.behavior(async () => done); f.runtime.start();
    await until(() => f.store.input("work")?.status === "completed");
    assert.equal(f.calls.filter((call) => call.conversationId === "worker").length, 1);
  } finally { await f.runtime.stop(); f.db.close(); }
});
