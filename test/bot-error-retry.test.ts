import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, openDatabaseConnection, type Db } from "../src/main/engine/db.ts";
import { BotRuntime } from "../src/main/bot/bot-runtime.ts";
import { BotStore } from "../src/main/bot/bot-store.ts";
import type { BotConversationMeta, BotExecutionOutcome, BotHost, BotInput } from "../src/shared/bot.ts";

const done: BotExecutionOutcome = { status: "completed", text: "已完成" };
const failed: BotExecutionOutcome = { status: "failed", text: "", error: "Vivi execution timed out" };
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
async function until(check: () => boolean): Promise<void> {
  for (let index = 0; index < 500; index++) { if (check()) return; await tick(); }
  throw new Error("execution did not settle");
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => { resolve = yes; });
  return { promise, resolve };
}
function fixture(db: Db = openDatabase(":memory:")) {
  const store = new BotStore(db);
  const calls: Parameters<BotHost["execute"]>[0][] = [];
  const created: Parameters<BotHost["createConversation"]>[0][] = [];
  let execute: BotHost["execute"] = async () => done;
  const host: BotHost = {
    createConversation: async (input) => { created.push(input); return { conversationId: input.kind === "router" ? "router" : `worker:${input.key}` }; },
    execute: async (input) => { calls.push(input); return execute(input); },
    snapshot: async () => { throw new Error("unused"); },
    messages: async () => [], abort: async () => {}, resolveProject: () => "/workspace", changed: () => {},
  };
  const runtime = new BotRuntime(store, host);
  const meta = (conversationId: string, extra: Partial<BotConversationMeta> = {}) => {
    const value: BotConversationMeta = { conversationId, role: conversationId === "router" ? "router" : "worker", creationKey: conversationId, owner: "vivi", epoch: 0, paused: false, createdAt: 1, updatedAt: 1, ...extra };
    store.putConversation(value);
    if (value.role === "router") store.setRouterConversationId(conversationId);
    return value;
  };
  const receipt = (id: string, conversationId: string, extra: Partial<BotInput> = {}) => {
    const value: BotInput = { id, conversationId, epoch: 0, source: "user", text: "核查代码", status: "failed", error: "503: overloaded", createdAt: 10, completedAt: 20, ...extra };
    store.putInput(value);
    return value;
  };
  return { db, store, host, runtime, calls, created, meta, receipt, behavior: (fn: BotHost["execute"]) => { execute = fn; } };
}

test("执行错误留在所属回执及结果，快照全局错误为空，数据库重开仍能重试", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vivi-error-retry-"));
  const path = join(dir, "state.db");
  const first = fixture(openDatabaseConnection(path));
  let reopened: ReturnType<typeof fixture> | undefined;
  try {
    first.behavior(async () => failed);
    first.runtime.start();
    await first.runtime.submit({ requestId: "user-request", text: "核查代码" });
    await until(() => first.store.input("user-request")?.status === "failed" && !first.runtime.activity().running);
    const snapshot = await first.runtime.getWorkSnapshot();
    assert.equal(snapshot.error, undefined);
    assert.deepEqual(snapshot.executionErrors, [{ conversationId: "router", inputId: "user-request", error: failed.error, createdAt: first.store.input("user-request")!.completedAt, startedAt: first.store.input("user-request")!.startedAt }]);
    assert.equal(snapshot.messages.find((message) => message.kind === "result")?.result?.status, "failed");
    assert.equal(snapshot.messages.find((message) => message.kind === "result")?.inputId, "user-request");
    await first.runtime.stop(); first.db.close();

    reopened = fixture(openDatabaseConnection(path));
    reopened.runtime.start();
    await tick();
    assert.deepEqual((await reopened.runtime.getWorkSnapshot()).executionErrors, snapshot.executionErrors);
    assert.equal(reopened.calls.length, 0, "重启不自动重新执行失败的输入");
    await reopened.runtime.continueConversation({ conversationId: "router", inputId: "user-request" });
    await until(() => reopened!.calls.length === 1 && !reopened!.runtime.activity().running);
    assert.deepEqual((await reopened.runtime.getWorkSnapshot()).executionErrors, []);
    assert.equal(reopened.created.length, 0, "重试复用已有持久会话");
  } finally {
    await reopened?.runtime.stop(); reopened?.db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("失败收尾清除 active 后的广播立即带出 executionErrors", async () => {
  const f = fixture();
  const snapshots: ReturnType<BotRuntime["getWorkSnapshot"]>[] = [];
  try {
    f.host.changed = () => { snapshots.push(f.runtime.getWorkSnapshot()); };
    f.behavior(async () => failed);
    f.runtime.start();
    await f.runtime.submit({ requestId: "failure-broadcast", text: "核查代码" });
    await until(() => f.store.input("failure-broadcast")?.status === "failed" && !f.runtime.activity().running);
    const published = await Promise.all(snapshots);
    assert.ok(published.some((snapshot) => snapshot.executionErrors?.some((error) => error.inputId === "failure-broadcast")), "必须由终态广播触发读取，而非依赖客户端稍后再轮询");
    assert.equal(published.at(-1)?.executionErrors?.[0]?.inputId, "failure-broadcast");
    assert.equal(published.at(-1)?.messages.find((message) => message.inputId === "failure-broadcast" && message.kind === "result")?.result?.status, "failed");
  } finally { await f.runtime.stop(); f.db.close(); }
});

test("图片输入可沿原会话重试，多次失败保留原要求、图片和记忆引用，重复点击幂等", async () => {
  const f = fixture();
  const gate = deferred<BotExecutionOutcome>();
  const images = [{ type: "image" as const, mimeType: "image/png", data: "aW1hZ2U=" }];
  const memoryRefs = [{ path: "MEMORY.md", heading: "约定" }];
  try {
    f.behavior(async () => failed);
    f.runtime.start();
    await f.runtime.submit({ requestId: "image-only", text: "", images, memoryRefs });
    await until(() => f.store.input("image-only")?.status === "failed" && !f.runtime.activity().running);
    f.behavior(() => gate.promise);
    await Promise.all(Array.from({ length: 3 }, () => f.runtime.continueConversation({ conversationId: "router", inputId: "image-only" })));
    await until(() => f.calls.length === 2);
    assert.deepEqual((await f.runtime.getWorkSnapshot()).executionErrors, [], "重试运行时不再提供旧错误按钮");
    assert.equal(f.store.inputs().filter((input) => input.source === "resume").length, 1);
    const retry = f.calls[1];
    assert.equal(retry.conversationId, "router");
    assert.deepEqual(retry.images, images);
    assert.match(retry.text, /without repeating completed actions/);
    assert.equal(f.store.input(retry.requestId)?.recoveryOf, "image-only");
    assert.deepEqual(f.store.input(retry.requestId)?.memoryRefs, memoryRefs);
    gate.resolve(failed);
    await until(() => f.store.input(retry.requestId)?.status === "failed" && !f.runtime.activity().running);
    assert.equal((await f.runtime.getWorkSnapshot()).executionErrors?.[0]?.inputId, retry.requestId);
    f.behavior(async () => done);
    await f.runtime.continueConversation({ conversationId: "router", inputId: retry.requestId });
    await until(() => f.calls.length === 3 && !f.runtime.activity().running);
    assert.deepEqual(f.calls[2].images, images);
    assert.equal(f.store.input(f.calls[2].requestId)?.rootInputId, "image-only");
    assert.equal(f.created.length, 1);
    assert.deepEqual((await f.runtime.getWorkSnapshot()).executionErrors, []);
  } finally { gate.resolve(failed); await f.runtime.stop(); f.db.close(); }
});

test("有新输入、暂停、待答或 epoch 已变化时，旧失败按钮不能恢复执行", async (t) => {
  for (const condition of ["new-failed", "new-completed", "queued", "accepted", "running", "paused", "attention", "epoch", "wrong-conversation"] as const) {
    await t.test(condition, async () => {
      const f = fixture();
      try {
        const meta = f.meta("router");
        f.receipt("old", "router");
        assert.equal((await f.runtime.getWorkSnapshot()).executionErrors?.[0]?.inputId, "old");
        if (condition === "paused") f.store.putConversation({ ...meta, paused: true });
        else if (condition === "epoch") f.store.putConversation({ ...meta, epoch: 1 });
        else if (condition === "attention") f.store.putAttention({ id: "question", conversationId: "router", inputId: "old", epoch: 0, status: "pending", question: "选择哪一个", createdAt: 30 });
        else if (condition === "wrong-conversation") { f.meta("other"); f.receipt("other-error", "other", { createdAt: 30 }); }
        else f.receipt("new", "router", { status: condition === "new-failed" ? "failed" : condition === "new-completed" ? "completed" : condition, createdAt: 30 });
        const before = f.store.inputs();
        const revision = f.store.revision;
        const result = await f.runtime.continueConversation({ conversationId: condition === "wrong-conversation" ? "other" : "router", inputId: "old" });
        assert.deepEqual(f.store.inputs(), before);
        assert.equal(f.store.revision, revision);
        assert.equal(f.calls.length, 0);
        if (condition === "new-failed") assert.equal(result.executionErrors?.[0]?.inputId, "new");
        else if (condition !== "wrong-conversation") assert.deepEqual(result.executionErrors, []);
      } finally { await f.runtime.stop(); f.db.close(); }
    });
  }
});

test("新请求成功后旧失败不再可重试，也不会重放上一轮要求", async () => {
  const f = fixture();
  try {
    f.behavior(async (input) => input.requestId === "old" ? failed : done);
    f.runtime.start();
    await f.runtime.submit({ requestId: "old", text: "旧要求" });
    await until(() => !f.runtime.activity().running);
    await f.runtime.submit({ requestId: "new", text: "新要求" });
    await until(() => f.store.input("new")?.status === "completed" && !f.runtime.activity().running);
    await f.runtime.continueConversation({ conversationId: "router", inputId: "old" });
    await tick();
    assert.equal(f.calls.length, 2);
    assert.deepEqual((await f.runtime.getWorkSnapshot()).executionErrors, []);
  } finally { await f.runtime.stop(); f.db.close(); }
});

test("Router 汇报失败可重复重试同一 ready 结果，Worker 不重跑且投递最终正确完成", async () => {
  const f = fixture();
  let reports = 0;
  try {
    f.behavior(async (input) => {
      if (input.conversationId !== "router") {
        await f.runtime.report({ conversationId: input.conversationId, requestId: input.requestId, outcome: "ready", summary: "已有文档已核查", evidence: ["文件核查通过"], artifacts: ["/workspace/report.md"] });
        return done;
      }
      if (input.requestId === "root") return done;
      reports++;
      assert.match(input.text, /已有文档已核查/);
      assert.match(input.text, /report.md/);
      return reports < 3 ? failed : done;
    });
    f.runtime.start();
    await f.runtime.submit({ requestId: "root", text: "核查文档" });
    await until(() => !f.runtime.activity().running);
    const worker = await f.runtime.createWork({ requestId: "work", title: "核查", text: "核查文档" });
    await until(() => f.store.deliveries("failed").length === 1 && !f.runtime.activity().running);
    const result = f.store.results(worker.conversationId)[0];
    const delivery = f.store.deliveries()[0];
    assert.equal(result.status, "ready");
    assert.equal((await f.runtime.getWorkSnapshot()).error, undefined);
    const firstError = (await f.runtime.getWorkSnapshot()).executionErrors!.find((error) => error.conversationId === "router")!;
    assert.equal(firstError.inputId, delivery.id);
    await f.runtime.continueConversation({ conversationId: "router", inputId: firstError.inputId });
    await until(() => reports === 2 && !f.runtime.activity().running);
    assert.equal(f.store.delivery(delivery.id)?.status, "failed");
    const secondError = (await f.runtime.getWorkSnapshot()).executionErrors!.find((error) => error.conversationId === "router")!;
    assert.notEqual(secondError.inputId, firstError.inputId);
    assert.deepEqual(f.store.input(secondError.inputId)?.deliveryIds, [delivery.id]);
    assert.deepEqual(f.store.chatMessages().filter((message) => message.conversationId === "router" && message.result?.status === "failed").map((message) => message.inputId).sort(), [firstError.inputId, secondError.inputId].sort(), "每次 Router 失败都留下独立的 result/chat 行");
    await f.runtime.continueConversation({ conversationId: "router", inputId: secondError.inputId });
    await until(() => reports === 3 && !f.runtime.activity().running);
    assert.deepEqual(f.store.input(f.calls.at(-1)!.requestId)?.deliveryIds, [delivery.id], "二次重试沿用原结果投递标识");
    assert.equal(f.store.delivery(delivery.id)?.status, "delivered");
    assert.equal(f.calls.filter((call) => call.conversationId === worker.conversationId).length, 1);
    assert.deepEqual(f.store.results(worker.conversationId), [result]);
    assert.equal(f.created.length, 2);
    assert.deepEqual((await f.runtime.getWorkSnapshot()).executionErrors, []);
    const before = f.calls.length;
    await f.runtime.continueConversation({ conversationId: "router", inputId: secondError.inputId });
    await tick(); assert.equal(f.calls.length, before);
  } finally { await f.runtime.stop(); f.db.close(); }
});

test("定向重试新要求不消费旧失败汇报，user 和 resume 保留原要求与附件", async (t) => {
  for (const source of ["user", "resume"] as const) await t.test(source, async () => {
    const f = fixture();
    const images = [{ type: "image" as const, mimeType: "image/png", data: "aW1hZ2U=" }];
    try {
      f.meta("router"); f.meta("worker");
      f.receipt("old-report", "router", { source: "report", text: "旧结果" });
      f.store.putDelivery({ id: "old-report", conversationId: "worker", targetConversationId: "router", status: "failed", text: "旧结果", createdAt: 6 });
      const oldDelivery = f.store.delivery("old-report");
      f.receipt("new-user", "router", { text: "核查新的需求和附件", images, createdAt: 30 });
      if (source === "resume") f.receipt("new-resume", "router", { source: "resume", text: "恢复提示", recoveryOf: "new-user", rootInputId: "new-user", createdAt: 40 });
      f.runtime.start();
      await f.runtime.continueConversation({ conversationId: "router", inputId: source === "user" ? "new-user" : "new-resume" });
      await until(() => f.calls.length === 1 && !f.runtime.activity().running);
      assert.match(f.calls[0].text, /核查新的需求和附件/);
      assert.doesNotMatch(f.calls[0].text, /旧结果/);
      assert.deepEqual(f.calls[0].images, images);
      assert.deepEqual(f.store.delivery("old-report"), oldDelivery);
      assert.equal(f.store.input(f.calls[0].requestId)?.deliveryIds, undefined);
    } finally { await f.runtime.stop(); f.db.close(); }
  });
});

test("独立失败汇报的定向重试只消费本次 receipt 或显式 deliveryIds", async (t) => {
  for (const source of ["report", "resume", "user-resume"] as const) await t.test(source, async () => {
    const f = fixture();
    const images = [{ type: "image" as const, mimeType: "image/png", data: "aW1hZ2U=" }];
    try {
      f.meta("router"); f.meta("worker");
      for (const [index, id] of ["old-report", "selected-report"].entries()) {
        f.receipt(id, "router", { source: "report", text: id, createdAt: 10 + index });
        f.store.putDelivery({ id, conversationId: "worker", targetConversationId: "router", status: "failed", text: id, createdAt: 6 + index });
      }
      let inputId = "selected-report";
      if (source !== "report") {
        if (source === "user-resume") f.receipt("user-root", "router", { text: "本次原始要求", images, createdAt: 20 });
        inputId = "selected-resume";
        f.receipt(inputId, "router", { source: "resume", text: "恢复提示", recoveryOf: source === "resume" ? "selected-report" : "user-root", rootInputId: source === "resume" ? "selected-report" : "user-root", deliveryIds: ["selected-report"], createdAt: 30 });
      }
      const oldDelivery = f.store.delivery("old-report");
      f.runtime.start();
      await f.runtime.continueConversation({ conversationId: "router", inputId });
      await until(() => f.calls.length === 1 && !f.runtime.activity().running);
      assert.match(f.calls[0].text, /selected-report/);
      assert.doesNotMatch(f.calls[0].text, /old-report/);
      assert.deepEqual(f.store.input(f.calls[0].requestId)?.deliveryIds, ["selected-report"]);
      assert.equal(f.store.delivery("selected-report")?.status, "delivered");
      assert.deepEqual(f.store.delivery("old-report"), oldDelivery);
      assert.equal(f.calls[0].conversationId, "router", "只恢复 Router 汇报，不执行 Worker");
      if (source === "user-resume") {
        assert.match(f.calls[0].text, /本次原始要求/);
        assert.deepEqual(f.calls[0].images, images);
      }
    } finally { await f.runtime.stop(); f.db.close(); }
  });
});

test("普通继续也会消费 failed 投递，而不是遗漏已有结果", async () => {
  const f = fixture();
  try {
    f.meta("router"); f.meta("worker"); f.receipt("report", "router", { source: "report" });
    f.store.putResult({ id: "ready", conversationId: "worker", epoch: 0, status: "ready", summary: "已有结果", createdAt: 5 });
    f.store.putDelivery({ id: "report", conversationId: "worker", targetConversationId: "router", status: "failed", resultId: "ready", text: "已有结果", createdAt: 6 });
    f.behavior(async (input) => { assert.match(input.text, /已有结果/); return done; });
    f.runtime.start();
    await f.runtime.continueConversation({ conversationId: "router" });
    await until(() => f.store.delivery("report")?.status === "delivered" && !f.runtime.activity().running);
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0].conversationId, "router");
  } finally { await f.runtime.stop(); f.db.close(); }
});

test("基础设施错误仍在全局快照中保留，其他会话成功不把它误清除", async () => {
  const f = fixture();
  try {
    f.host.changed = () => { throw new Error("broadcast transport unavailable"); };
    f.runtime.start();
    await f.runtime.submit({ requestId: "success", text: "核查代码" });
    await until(() => f.store.input("success")?.status === "completed" && !f.runtime.activity().running);
    const snapshot = await f.runtime.getWorkSnapshot();
    assert.equal(snapshot.error, "broadcast transport unavailable");
    assert.deepEqual(snapshot.executionErrors, []);
  } finally { await f.runtime.stop(); f.db.close(); }
});

test("运行收尾意外失败仍保存可定位回执和错误结果，不污染全局错误", async () => {
  const f = fixture();
  try {
    // The model succeeded, but its invalid epilogue fails the runtime reply validation.
    f.behavior(async () => ({ status: "completed", text: "x".repeat(16_001) }));
    f.runtime.start();
    await f.runtime.submit({ requestId: "bad-epilogue", text: "核查代码" });
    await until(() => f.store.input("bad-epilogue")?.status === "failed" && !f.runtime.activity().running);
    const snapshot = await f.runtime.getWorkSnapshot();
    assert.equal(snapshot.error, undefined);
    assert.equal(snapshot.executionErrors?.[0]?.inputId, "bad-epilogue");
    assert.match(snapshot.executionErrors![0].error, /16000/);
    assert.equal(snapshot.messages.find((message) => message.kind === "result")?.result?.status, "failed");
    assert.equal(snapshot.results.find((result) => result.inputId === "bad-epilogue")?.summary, f.store.input("bad-epilogue")?.error);
  } finally { await f.runtime.stop(); f.db.close(); }
});
