import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { chmodSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { ModelRuntime, type ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { createFauxCore, fauxAssistantMessage, fauxToolCall, InMemoryModelsStore } from "@earendil-works/pi-ai";
import { openShadowStore } from "../src/main/bot/shadow/store.ts";
import { ScratchPiSession } from "../src/main/bot/shadow/pi-session.ts";
import type { WorkerToken } from "../src/main/bot/shadow/engine.ts";

const binding: WorkerToken = { ticketId: "sdk-ticket", assignmentId: "sdk-assignment", generation: 1, claimToken: 1 };
type Options = Parameters<typeof ScratchPiSession.open>[0];
type Responses = Parameters<ReturnType<typeof createFauxCore>["setResponses"]>[0];
const timeout = { timeout: 15_000 };
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
async function until(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("真实 SDK 未在期限内到达预期边界");
    await new Promise<void>(done => setImmediate(done));
  }
}
async function harness(t: TestContext, responses: Responses, overrides: Partial<Options> = {}, streamSimple?: ReturnType<typeof createFauxCore>["streamSimple"]) {
  const root = mkdtempSync(join(tmpdir(), "vivi-dsh-pi-"));
  chmodSync(root, 0o700);
  const file = join(root, "shadow.db");
  let store = openShadowStore(file);
  const faux = createFauxCore({ api: "dsh-faux-api", provider: "dsh-faux", models: [{ id: "scripted" }] });
  faux.setResponses(responses);
  const runtime = await ModelRuntime.create({ authPath: join(root, "auth.json"), modelsPath: null, modelsStore: new InMemoryModelsStore(), allowModelNetwork: false, refreshOnCreate: false });
  runtime.registerProvider("dsh-faux", { baseUrl: "http://faux.invalid", api: "dsh-faux-api" as never, apiKey: "unused", streamSimple: faux.streamSimple as never, models: [{ id: "scripted", name: "scripted", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100_000, maxTokens: 4096 }] });
  // Fault injection at the SDK runtime dispatch boundary: ModelRuntime normally
  // wraps provider failures in a lazy error stream, which is a returned stream.
  if (streamSimple) runtime.streamSimple = streamSimple as typeof runtime.streamSimple;
  const sessions: ScratchPiSession[] = [];
  const options = () => ({ store, root, binding, modelRuntime: runtime, model: runtime.getModel("dsh-faux", "scripted")!, ...overrides });
  const open = async (extra: Partial<Options> = {}) => {
    const adapter = await ScratchPiSession.open({ ...options(), ...extra });
    sessions.push(adapter);
    return adapter;
  };
  t.after(async () => {
    for (const adapter of sessions.reverse()) await adapter.dispose();
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  const adapter = await open();
  return { adapter, faux, root, file, open, get store() { return store; }, async restart() {
    await sessions.at(-1)!.dispose();
    store.close(); store = openShadowStore(file);
    return open();
  } };
}
function entries(adapter: ScratchPiSession) {
  return readFileSync(adapter.session.sessionFile!, "utf8").trim().split("\n").map(line => JSON.parse(line));
}
function users(adapter: ScratchPiSession) {
  return entries(adapter).filter(entry => entry.type === "message" && entry.message.role === "user");
}
function mapped(adapter: ScratchPiSession, requestId: string) {
  const receipt = adapter.get(requestId);
  assert.ok(receipt?.entryId, `请求 ${requestId} 必须关联真实 JSONL entryId`);
  const matching = users(adapter).filter(entry => entry.id === receipt.entryId);
  assert.equal(matching.length, 1);
  assert.ok(Number.isSafeInteger(receipt.entryEpoch), "持久 entry 必须记录真实 dispatch epoch");
  assert.ok(receipt.entryBinding, "持久 entry 必须记录真实 dispatch binding");
  assert.deepEqual(matching[0].message.__fastvibeDsh, {
    version: 1, sessionKey: adapter.sessionKey, requestId,
    epoch: receipt.entryEpoch, binding: receipt.entryBinding,
  });
  return { receipt, entry: matching[0] };
}

test("idle submit 在 preflight 接受后即返回，completion 等真实 SDK idle，JSONL 精确记录 persisted/read/turn", timeout, async t => {
  const gate = deferred(); t.after(gate.resolve);
  const reads: string[][] = [], persisted: string[][] = [];
  const h = await harness(t, [async () => { await gate.promise; return fauxAssistantMessage("实际 SDK 回复"); }], {
    onRead: (token, ids) => { assert.deepEqual(token, binding); reads.push(ids); },
    onPersisted: (token, ids) => { assert.deepEqual(token, binding); persisted.push(ids); },
  });
  const result = await h.adapter.submit({ requestId: "idle", text: "检查输入", inputIds: ["input-1"] });
  assert.equal(result.reused, false);
  await until(() => h.faux.state.callCount === 1);
  assert.equal(h.adapter.session.isIdle, false);
  let completed = false; void result.completion.then(() => { completed = true; });
  await new Promise<void>(done => setImmediate(done)); assert.equal(completed, false);
  const before = mapped(h.adapter, "idle");
  assert.equal(before.receipt.stage, "read");
  assert.equal(before.receipt.reads[0]?.entryId, before.entry.id);
  assert.deepEqual(reads, [["input-1"]]); assert.deepEqual(persisted, [["input-1"]]);
  gate.resolve(); await result.completion;
  assert.equal(h.adapter.session.isIdle, true);
  assert.ok(h.adapter.get("idle")!.turns.length >= 1);
  assert.match(JSON.stringify(entries(h.adapter)), /实际 SDK 回复/);
  const markers = entries(h.adapter).filter(entry => entry.type === "custom");
  assert.ok(markers.some(entry => entry.customType === "fastvibe-dsh-read" && entry.data.requestIds.includes("idle")));
  assert.ok(markers.some(entry => entry.customType === "fastvibe-dsh-turn" && entry.data.requestIds.includes("idle")));
  assert.equal(statSync(h.adapter.session.sessionFile!).mode & 0o077, 0);
  assert.equal(statSync(h.root).mode & 0o077, 0);
});

test("相同 text 不同 requestId 各落一条；同 id replay 不重跑；异内容/inputs/mode 拒绝", timeout, async t => {
  const h = await harness(t, [fauxAssistantMessage("一"), fauxAssistantMessage("二")]);
  const input = { requestId: "first", text: "相同文字", inputIds: ["one"], mode: "steer" as const };
  await (await h.adapter.submit(input)).completion;
  const second = await h.adapter.submit({ ...input, requestId: "second" }); await second.completion;
  const firstEntry = mapped(h.adapter, "first").entry.id;
  assert.notEqual(mapped(h.adapter, "second").entry.id, firstEntry);
  const replay = await h.adapter.submit(input); await replay.completion;
  assert.equal(replay.reused, true); assert.equal(h.faux.state.callCount, 2); assert.equal(users(h.adapter).length, 2);
  await assert.rejects(h.adapter.submit({ ...input, text: "修改内容" }));
  await assert.rejects(h.adapter.submit({ ...input, inputIds: ["other"] }));
  await assert.rejects(h.adapter.submit({ ...input, mode: "followUp" }));
  assert.equal(mapped(h.adapter, "first").entry.id, firstEntry);
});

for (const mode of ["steer", "followUp"] as const) test(`streaming ${mode} 经真实 SDK 排队并保留独立 ALS request 映射`, timeout, async t => {
  const gate = deferred(); t.after(gate.resolve);
  const h = await harness(t, [async () => { await gate.promise; return fauxAssistantMessage("首轮"); }, fauxAssistantMessage("后续")]);
  const first = await h.adapter.submit({ requestId: "first", text: "同样的输入", inputIds: ["one"] });
  await until(() => h.faux.state.callCount === 1);
  const queued = await h.adapter.submit({ requestId: "next", text: "同样的输入", inputIds: ["two"], mode });
  assert.equal(queued.receipt.status, "queued");
  assert.equal(h.adapter.get("next")!.entryId, undefined);
  assert.equal(h.faux.state.callCount, 1);
  gate.resolve(); await Promise.all([first.completion, queued.completion]);
  assert.equal(h.faux.state.callCount, 2); assert.equal(users(h.adapter).length, 2);
  assert.notEqual(mapped(h.adapter, "first").entry.id, mapped(h.adapter, "next").entry.id);
  assert.equal(h.adapter.get("next")!.stage, "read");
});

for (const mode of ["steer", "followUp"] as const) test(`streaming ${mode} 输入 hook 内嵌 SDK 消息不抢走原始 B 的 request tag`, timeout, async t => {
  const gate = deferred(); t.after(gate.resolve);
  let nested = false;
  const extension: ExtensionFactory = pi => {
    pi.on("input", async event => {
      if (event.text === "INPUT_B" && !nested) {
        nested = true;
        await pi.sendUserMessage("DERIVED_FROM_INPUT_HOOK", { deliverAs: "followUp" });
      }
    });
  };
  const h = await harness(t, [async () => { await gate.promise; return fauxAssistantMessage("A 完成"); }, fauxAssistantMessage("派生完成"), fauxAssistantMessage("B 完成")], { extensions: [extension] });
  const a = await h.adapter.submit({ requestId: "A", text: "INPUT_A", inputIds: ["a"] });
  await until(() => h.faux.state.callCount === 1);
  const b = await h.adapter.submit({ requestId: "B", text: "INPUT_B", inputIds: ["b"], mode });
  assert.equal(b.receipt.status, "queued");
  gate.resolve();
  await Promise.all([a.completion, b.completion]);
  assert.equal(nested, true);
  assert.equal(h.faux.state.callCount, 3);
  const bMapped = mapped(h.adapter, "B");
  assert.match(JSON.stringify(bMapped.entry.message.content), /INPUT_B/);
  assert.doesNotMatch(JSON.stringify(bMapped.entry.message.content), /DERIVED_FROM_INPUT_HOOK/);
  const allUsers = users(h.adapter);
  const derived = allUsers.find(entry => JSON.stringify(entry.message.content).includes("DERIVED_FROM_INPUT_HOOK"));
  assert.ok(derived, "嵌套 SDK 消息必须真实落盘");
  assert.equal(derived.message.__fastvibeDsh, undefined, "嵌套派生消息不得继承 B 的 request tag");
  assert.equal(allUsers.filter(entry => entry.message.__fastvibeDsh?.requestId === "B").length, 1);
  assert.equal(h.adapter.ledger.list(h.adapter.sessionKey).filter(receipt => receipt.requestId === "B").length, 1);
  assert.equal(h.adapter.ledger.list(h.adapter.sessionKey).some(receipt => receipt.text === "DERIVED_FROM_INPUT_HOOK"), false);
});


test("input handled 不产生 user/read；input transform 的真实落盘文本仍映射原 requestId", timeout, async t => {
  const extension: ExtensionFactory = pi => { pi.on("input", event => event.text === "consume" ? { action: "handled" } : { action: "transform", text: "TRANSFORMED_INPUT" }); };
  let providerInput = "";
  const h = await harness(t, [context => { providerInput = JSON.stringify(context.messages); return fauxAssistantMessage("完成"); }], { extensions: [extension] });
  const handled = await h.adapter.submit({ requestId: "handled", text: "consume" }); await handled.completion;
  assert.equal(handled.receipt.status, "handled"); assert.equal(h.adapter.get("handled")!.entryId, undefined);
  assert.equal(h.adapter.get("handled")!.reads.length, 0); assert.equal(h.faux.state.callCount, 0);
  await (await h.adapter.submit({ requestId: "transformed", text: "original" })).completion;
  const { receipt, entry } = mapped(h.adapter, "transformed");
  assert.equal(receipt.text, "original"); assert.match(JSON.stringify(entry.message.content), /TRANSFORMED_INPUT/);
  assert.match(providerInput, /TRANSFORMED_INPUT/); assert.doesNotMatch(providerInput, /original/);
  assert.equal((await h.adapter.submit({ requestId: "handled", text: "consume" })).reused, true);
  assert.equal(h.faux.state.callCount, 1);
});

test("context hook 过滤输入：真实 JSONL 已 persisted 但提供方未读，不得混淆 receipt stage", timeout, async t => {
  const reads: string[][] = [], persisted: string[][] = [];
  const extension: ExtensionFactory = pi => { pi.on("context", event => ({ messages: event.messages.filter(message => message.role !== "user") })); };
  const h = await harness(t, [context => { assert.ok(context.messages.every(message => message.role !== "user")); return fauxAssistantMessage("无输入"); }], {
    extensions: [extension], onRead: (_token, ids) => { reads.push(ids); }, onPersisted: (_token, ids) => { persisted.push(ids); },
  });
  await (await h.adapter.submit({ requestId: "filtered", text: "不能假装读过", inputIds: ["filtered-input"] })).completion;
  const { receipt } = mapped(h.adapter, "filtered");
  assert.equal(receipt.stage, "persisted"); assert.deepEqual(receipt.reads, []);
  assert.deepEqual(reads, []); assert.deepEqual(persisted, [["filtered-input"]]);
  const recovered = await h.adapter.recover("filtered"); await recovered.completion;
  assert.equal(h.faux.state.callCount, 1, "已落盘但未读的输入不得被 recover 重投成重复 user message");
  assert.equal(mapped(h.adapter, "filtered").receipt.entryId, receipt.entryId);
});

test("真实 dsh_report 工具写 ledger 和 onReport，assistant prose 不替代结构化报告", timeout, async t => {
  const reports: unknown[] = [];
  const report = { state: "ready", summary: "核对完成" };
  const h = await harness(t, [fauxAssistantMessage([fauxToolCall("dsh_report", report)], { stopReason: "toolUse" }), fauxAssistantMessage("普通正文")], {
    onReport: (token, value) => { assert.deepEqual(token, binding); reports.push(value); return true; },
  });
  assert.ok(h.adapter.session.getActiveToolNames().includes("dsh_report"));
  await (await h.adapter.submit({ requestId: "report", text: "完成后报告", inputIds: ["work"] })).completion;
  assert.deepEqual(reports, [report]);
  const receipt = mapped(h.adapter, "report").receipt;
  assert.equal(receipt.stage, "reported"); assert.equal(receipt.reports.length, 1);
  assert.deepEqual(receipt.reports[0]!.report, report);
  assert.ok(entries(h.adapter).some(entry => entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolName === "dsh_report"));
});

test("关库重开复用固定 SessionFile 与 JSONL request 映射，无自动重投", timeout, async t => {
  const h = await harness(t, [fauxAssistantMessage("持久回复")]);
  await (await h.adapter.submit({ requestId: "persist", text: "持久输入", inputIds: ["one"] })).completion;
  const file = h.adapter.session.sessionFile!, id = mapped(h.adapter, "persist").entry.id;
  const reopened = await h.restart();
  assert.equal(reopened.sessionKey, `worker-${binding.ticketId}`); assert.equal(reopened.session.sessionFile, file);
  assert.equal(mapped(reopened, "persist").entry.id, id); assert.equal(h.faux.state.callCount, 1);
  assert.equal(h.faux.state.callCount, 1, "重开不得自动运行");
  await reopened.resume();
  assert.equal((await reopened.submit({ requestId: "persist", text: "持久输入", inputIds: ["one"] })).reused, true);
  assert.equal(h.faux.state.callCount, 1);
});

for (const corruption of ["missing", "corrupt"] as const) test(`已有 ledger 的 session ${corruption} 必须 fail closed，不新建替代历史`, timeout, async t => {
  const h = await harness(t, [fauxAssistantMessage("回复")]);
  await (await h.adapter.submit({ requestId: "first", text: "必须保留" })).completion;
  const file = h.adapter.session.sessionFile!;
  await h.adapter.dispose();
  if (corruption === "missing") rmSync(file); else writeFileSync(file, "{broken json\n");
  await assert.rejects(h.open());
  assert.ok(h.adapter.get("first")!.entryId);
});

test("Stop 在异步 preflight 中先持久 paused/epoch，迟到 preflight 不得开始 provider", timeout, async t => {
  const entered = deferred(), release = deferred(); t.after(release.resolve);
  const extension: ExtensionFactory = pi => { pi.on("before_agent_start", async () => { entered.resolve(); await release.promise; }); };
  const h = await harness(t, [fauxAssistantMessage("不应请求")], { extensions: [extension] });
  const before = h.adapter.ledger.session(h.adapter.sessionKey)!;
  const pending = h.adapter.submit({ requestId: "late", text: "慢 preflight" });
  // Attach the rejection observer immediately; Stop may reject submit before abort finishes.
  const outcome = pending.then(value => ({ value }), error => ({ error }));
  await entered.promise;
  const stopped = h.adapter.stop();
  await until(() => h.adapter.ledger.session(h.adapter.sessionKey)!.paused);
  const state = h.adapter.ledger.session(h.adapter.sessionKey)!;
  assert.ok(state.epoch > before.epoch);
  release.resolve(); await stopped;
  const result = await outcome;
  if ("value" in result) await result.value.completion.catch(() => {});
  assert.equal(h.faux.state.callCount, 0);
  assert.equal(h.adapter.get("late")!.reads.length, 0);
  assert.equal(h.adapter.get("late")!.status, "stopped");
  await h.adapter.resume();
  assert.equal(h.adapter.ledger.session(h.adapter.sessionKey)!.paused, false);
  assert.equal(h.faux.state.callCount, 0, "resume 只解除暂停");
});

test("Stop 清除真实 SDK 队列；resume 不重投，Continue 不新增 user 且注入当前 context", timeout, async t => {
  const entered = deferred();
  let current = "CONTEXT_BEFORE_STOP";
  const h = await harness(t, [async (_context, options) => {
    entered.resolve();
    await new Promise<void>(done => {
      if (options?.signal?.aborted) done();
      else options?.signal?.addEventListener("abort", () => done(), { once: true });
    });
    return fauxAssistantMessage("已中断");
  }, context => {
    const text = JSON.stringify(context.messages);
    assert.match(text, /CONTEXT_AFTER_STOP/);
    assert.doesNotMatch(text, /QUEUED_MUST_NOT_RUN/);
    assert.ok(context.messages.every(message => message.role !== "assistant" || message.stopReason !== "aborted"));
    return fauxAssistantMessage("继续完成");
  }], { context: () => ({ phase: current }) });
  const running = await h.adapter.submit({ requestId: "running", text: "执行原工作" });
  await entered.promise;
  const queued = await h.adapter.submit({ requestId: "queued", text: "QUEUED_MUST_NOT_RUN", mode: "followUp" });
  assert.equal(queued.receipt.status, "queued");
  await h.adapter.stop(); await running.completion.catch(() => {}); await queued.completion.catch(() => {});
  assert.equal(h.adapter.get("queued")!.status, "stopped");
  assert.equal(h.adapter.get("queued")!.entryId, undefined);
  const count = users(h.adapter).length;
  current = "CONTEXT_AFTER_STOP";
  await h.adapter.resume(); assert.equal(h.faux.state.callCount, 1);
  const stoppedRecovery = await h.adapter.recover("queued"); await stoppedRecovery.completion;
  assert.equal(h.faux.state.callCount, 1, "人工 Stop 的输入不得被显式 recover 复活");
  await h.adapter.continue();
  assert.equal(h.faux.state.callCount, 2); assert.equal(users(h.adapter).length, count);
  assert.match(JSON.stringify(entries(h.adapter)), /继续完成/);
});

test("reload 等真实 SDK idle，保留实例适配、request marker 与每次 provider 的最新 context", timeout, async t => {
  const gate = deferred(); t.after(gate.resolve);
  let contextVersion = "RELOAD_OLD";
  const h = await harness(t, [async () => { await gate.promise; return fauxAssistantMessage("首轮"); }, context => {
    assert.match(JSON.stringify(context.messages), /RELOAD_NEW/); return fauxAssistantMessage("重载后");
  }], { context: () => ({ contextVersion }) });
  const first = await h.adapter.submit({ requestId: "before", text: "重载前" });
  await until(() => h.faux.state.callCount === 1);
  let reloaded = false;
  const reload = h.adapter.reload().then(() => { reloaded = true; });
  await new Promise<void>(done => setImmediate(done)); assert.equal(reloaded, false);
  gate.resolve(); await first.completion; await reload;
  contextVersion = "RELOAD_NEW";
  await (await h.adapter.submit({ requestId: "after", text: "重载后" })).completion;
  assert.equal(mapped(h.adapter, "before").receipt.stage, "read");
  assert.equal(mapped(h.adapter, "after").receipt.stage, "read");
  assert.ok(h.adapter.session.getActiveToolNames().includes("dsh_report"));
});

test("compact 运行真实 SDK summary 请求并持久化 compaction entry，压缩后仍可提交精确 marker", timeout, async t => {
  let contextVersion = "COMPACT_OLD";
  const h = await harness(t, [fauxAssistantMessage("第一轮事实"), fauxAssistantMessage("第二轮事实"), context => {
    assert.match(JSON.stringify(context.messages), /历史工作事实/);
    assert.match(JSON.stringify(context.messages), /COMPACT_NEW/);
    assert.ok(JSON.stringify(context.messages).includes(binding.assignmentId));
    return fauxAssistantMessage("## Goal\n保留原工作与两轮事实。\n## Progress\n已核对。");
  }, context => {
    assert.match(JSON.stringify(context.messages), /继续核对/);
    assert.match(JSON.stringify(context.messages), /COMPACT_NEW/);
    assert.ok(JSON.stringify(context.messages).includes(binding.assignmentId));
    return fauxAssistantMessage("## Original Request\n继续核对\n## Progress So Far\n已检查第一轮事实。");
  }, context => {
    assert.match(JSON.stringify(context.messages), /COMPACT_AFTER/); return fauxAssistantMessage("压缩后完成");
  }], { context: () => ({ contextVersion }) });
  await (await h.adapter.submit({ requestId: "one", text: "历史工作事实。".repeat(100) })).completion;
  await (await h.adapter.submit({ requestId: "two", text: "继续核对" })).completion;
  h.adapter.session.settingsManager.applyOverrides({ compaction: { enabled: false, keepRecentTokens: 0, reserveTokens: 1024 } });
  const count = users(h.adapter).length;
  const readsBefore = [h.adapter.get("one")!.reads.length, h.adapter.get("two")!.reads.length];
  contextVersion = "COMPACT_NEW"; await h.adapter.compact("保留原工作要求");
  assert.deepEqual([h.adapter.get("one")!.reads.length, h.adapter.get("two")!.reads.length], readsBefore, "summary 不得冒充 Worker 读取");
  assert.equal(h.faux.state.callCount, 4);
  const compactions = entries(h.adapter).filter(entry => entry.type === "compaction");
  assert.equal(compactions.length, 1); assert.match(compactions[0].summary, /保留原工作/);
  assert.equal(users(h.adapter).length, count);
  contextVersion = "COMPACT_AFTER";
  await (await h.adapter.submit({ requestId: "after", text: "压缩后新请求" })).completion;
  assert.equal(mapped(h.adapter, "after").receipt.stage, "read");
});

for (const reassign of [false, true]) test(`唯一 raw user 完全摘要后 Continue ${reassign ? "隔离新 Assignment 历史 read，直到新 raw 输入才可报告" : "关联历史 read 报告且不伪造新 raw read"}`, timeout, async t => {
  const originalText = "ORIGINAL_RAW_ONLY_7C91：核对原始工作事实。".repeat(100);
  const summary = "## Original Request\n继续核对历史工作。\n## Progress So Far\n已保留工作事实，等待完成报告。";
  const report = { state: "ready" as const, summary: "根据摘要完成工作" };
  const newer: WorkerToken = { ...binding, assignmentId: "summary-new-assignment", generation: 2, claimToken: 8 };
  const reports: { token: WorkerToken; summary: string }[] = [];
  const reads: { token: WorkerToken; ids: string[] }[] = [];
  let summaryOnlyRequests = 0;
  const summaryOnlyResponse = (context: Parameters<Extract<Responses[number], (...args: any[]) => any>>[0]) => {
    const material = JSON.stringify(context.messages);
    assert.match(material, /已保留工作事实/);
    assert.doesNotMatch(material, /ORIGINAL_RAW_ONLY_7C91|__fastvibeDsh/);
    assert.ok(material.includes(reassign ? newer.assignmentId : binding.assignmentId));
    summaryOnlyRequests++;
    return fauxAssistantMessage([fauxToolCall("dsh_report", report)], { stopReason: "toolUse" });
  };
  const h = await harness(t, [
    fauxAssistantMessage("原始输入已核对，尚需完成报告。"),
    context => {
      assert.match(JSON.stringify(context.messages), /ORIGINAL_RAW_ONLY_7C91/);
      return fauxAssistantMessage(summary);
    },
    summaryOnlyResponse,
    ...(reassign ? [fauxAssistantMessage("当前 Assignment 尚无新输入授权。"),
      fauxAssistantMessage([fauxToolCall("dsh_report", { ...report, summary: "新输入授权后完成" })], { stopReason: "toolUse" })] : []),
  ], {
    onRead: (token, ids) => { reads.push({ token, ids }); },
    onReport: (token, value) => { reports.push({ token, summary: value.summary }); return true; },
  });
  await (await h.adapter.submit({ requestId: "original-summary", text: originalText, inputIds: ["original-input"] })).completion;
  const original = mapped(h.adapter, "original-summary");
  assert.equal(original.receipt.reads.length, 1);
  const rawRead = original.receipt.reads[0];
  assert.deepEqual(rawRead.binding, binding);
  assert.equal(rawRead.entryId, original.entry.id);
  h.adapter.session.settingsManager.applyOverrides({ compaction: { enabled: false, keepRecentTokens: 0, reserveTokens: 1024 } });
  await h.adapter.compact("把原始请求全部归纳为摘要");
  assert.equal(h.faux.state.callCount, 2, "唯一 user 的真实 compaction 只需 turn-prefix summary");
  const compactions = entries(h.adapter).filter(entry => entry.type === "compaction");
  assert.equal(compactions.length, 1);
  assert.match(compactions[0].summary, /已保留工作事实/);
  assert.notEqual(compactions[0].firstKeptEntryId, original.entry.id);
  const projected = h.adapter.session.agent.state.messages;
  assert.ok(!projected.some(message => message.role === "user" && JSON.stringify(message).includes("ORIGINAL_RAW_ONLY_7C91")), "SDK compaction projection 必须真正移除原 user");
  assert.doesNotMatch(JSON.stringify(projected), /__fastvibeDsh/);
  assert.deepEqual(h.adapter.get("original-summary")!.reads, [rawRead]);
  assert.equal(reads.length, 1, "summary 请求不能产出 input read");
  if (reassign) await h.adapter.rebind(newer);
  const beforeContinue = entries(h.adapter).length;
  await h.adapter.continue();
  assert.equal(summaryOnlyRequests, 1);
  assert.equal(users(h.adapter).length, 1, "Continue 不得增加 user message");
  assert.deepEqual(h.adapter.get("original-summary")!.reads, [rawRead]);
  assert.equal(reads.length, 1, "summary-only Continue 不得新增 raw read callback");
  const continuedEntries = entries(h.adapter).slice(beforeContinue);
  const rawMarkers = continuedEntries.filter(entry => entry.type === "custom" && entry.customType === "fastvibe-dsh-read");
  assert.ok(rawMarkers.length > 0);
  assert.ok(rawMarkers.every(entry => entry.data.requestIds.length === 0), "新 provider turn 的 READ 不得把摘要关联冒充 raw 输入");
  const tool = continuedEntries.find(entry => entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolName === "dsh_report");
  assert.ok(tool, "Continue 必须真实调用 dsh_report 工具");
  if (!reassign) {
    assert.deepEqual(reports, [{ token: binding, summary: report.summary }]);
    const receipt = h.adapter.get("original-summary")!;
    assert.equal(receipt.reports.length, 1);
    const accepted = receipt.reports[0];
    assert.ok(accepted.readTurnId);
    assert.equal(accepted.readTurnId, rawRead.turnId);
    assert.notEqual(accepted.turnId, rawRead.turnId);
    assert.deepEqual(accepted.binding, binding);
    assert.ok(receipt.turns.some(turn => turn.turnId === accepted.turnId), "摘要报告 turn 仍需关联原工作 receipt");
    assert.ok(rawMarkers.some(entry => entry.data.turnId === accepted.turnId));
    assert.ok(continuedEntries.some(entry => entry.type === "custom" && entry.customType === "fastvibe-dsh-report" && entry.data.requestIds.includes("original-summary")));
    assert.equal(h.faux.state.callCount, 3);
  } else {
    assert.match(JSON.stringify(tool.message), /refused|拒绝/i);
    assert.deepEqual(reports, [], "新 Assignment 不能沿用旧 binding 的 read 调 domain report");
    assert.deepEqual(h.adapter.get("original-summary")!.reports, []);
    assert.ok(!continuedEntries.some(entry => entry.type === "custom" && entry.customType === "fastvibe-dsh-report"));
    await (await h.adapter.submit({ requestId: "new-summary-assignment", text: "新 Assignment 的明确原始输入", inputIds: ["new-input"] })).completion;
    const fresh = mapped(h.adapter, "new-summary-assignment").receipt;
    assert.equal(fresh.reads.length, 1);
    assert.deepEqual(fresh.reads[0].binding, newer);
    assert.equal(fresh.reports.length, 1);
    assert.equal(fresh.reports[0].readTurnId, fresh.reads[0].turnId);
    assert.notEqual(fresh.reports[0].readTurnId, rawRead.turnId);
    assert.deepEqual(reports, [{ token: newer, summary: "新输入授权后完成" }]);
    assert.deepEqual(reads, [{ token: binding, ids: ["original-input"] }, { token: newer, ids: ["new-input"] }]);
    assert.deepEqual(h.adapter.get("original-summary")!.reads, [rawRead]);
    assert.deepEqual(h.adapter.get("original-summary")!.reports, [], "新报告不能回填旧 Assignment receipt");
    assert.equal(users(h.adapter).length, 2);
    assert.equal(h.faux.state.callCount, 5);
  }
});

test("rebind 保持同 Ticket/SessionFile，新 provider 使用新 binding，跨 Ticket 拒绝", timeout, async t => {
  const newer: WorkerToken = { ...binding, assignmentId: "assignment-2", generation: 2, claimToken: 3 };
  const seen: WorkerToken[] = [];
  const h = await harness(t, [fauxAssistantMessage("旧工作"), context => {
    const material = JSON.stringify(context.messages);
    assert.match(material, /assignment-2/); return fauxAssistantMessage("新工作");
  }], { onRead: token => { seen.push(token); } });
  await (await h.adapter.submit({ requestId: "old", text: "旧工作" })).completion;
  const file = h.adapter.session.sessionFile;
  await h.adapter.rebind(newer);
  assert.equal(h.adapter.session.sessionFile, file); assert.equal(h.adapter.sessionKey, `worker-${binding.ticketId}`);
  await (await h.adapter.submit({ requestId: "new", text: "新工作" })).completion;
  assert.deepEqual(h.adapter.get("new")!.binding, newer); assert.deepEqual(seen.at(-1), newer);
  await assert.rejects(h.adapter.rebind({ ...newer, ticketId: "another-ticket" }));
  assert.equal(h.adapter.session.sessionFile, file);
});

test("rebind 后同一实例 recover 旧未落盘输入，使用新 binding read 且不重复 user", timeout, async t => {
  const entered = deferred();
  const newer: WorkerToken = { ...binding, assignmentId: "recovered-assignment", generation: 2, claimToken: 9 };
  const h = await harness(t, [async (_context, options) => {
    entered.resolve();
    await new Promise<void>(done => {
      if (options?.signal?.aborted) done();
      else options?.signal?.addEventListener("abort", () => done(), { once: true });
    });
    return fauxAssistantMessage("旧运行被中止");
  }, fauxAssistantMessage("recover 后完成")]);
  const running = await h.adapter.submit({ requestId: "running", text: "旧运行" });
  await entered.promise;
  const queued = await h.adapter.submit({ requestId: "recover-me", text: "未落盘输入", inputIds: ["recover-input"], mode: "followUp" });
  assert.equal(queued.receipt.status, "queued");
  await h.adapter.rebind(newer);
  await running.completion.catch(() => {});
  await queued.completion.catch(() => {});
  assert.equal(h.adapter.get("recover-me")!.status, "uncertain");
  const recovered = await h.adapter.recover("recover-me");
  await recovered.completion;
  const result = mapped(h.adapter, "recover-me");
  assert.deepEqual(result.receipt.binding, binding, "acceptance 身份保持不可变，恢复读取另记新 binding");
  assert.deepEqual(result.receipt.reads.at(-1)?.binding, newer);
  assert.equal(users(h.adapter).filter(entry => entry.message.__fastvibeDsh?.requestId === "recover-me").length, 1);
  assert.equal(users(h.adapter).filter(entry => JSON.stringify(entry.message.content).includes("未落盘输入")).length, 1);
});


test("extension 派生真实 user message 不复用 ALS 中的原 requestId，也不伪造额外 ledger receipt", timeout, async t => {
  let injected = false;
  const extension: ExtensionFactory = pi => { pi.on("agent_end", () => {
    if (!injected) { injected = true; pi.sendUserMessage("EXTENSION_DERIVED_INPUT", { deliverAs: "followUp" }); }
  }); };
  const h = await harness(t, [fauxAssistantMessage("初次回复"), fauxAssistantMessage("派生回复")], { extensions: [extension] });
  await (await h.adapter.submit({ requestId: "original", text: "原输入" })).completion;
  assert.equal(h.faux.state.callCount, 2);
  const all = users(h.adapter); assert.equal(all.length, 2);
  assert.equal(all.filter(entry => entry.message.__fastvibeDsh?.requestId === "original").length, 1);
  const derived = all.find(entry => JSON.stringify(entry.message.content).includes("EXTENSION_DERIVED_INPUT"));
  assert.ok(derived); assert.equal(derived.message.__fastvibeDsh, undefined);
  assert.equal(h.adapter.ledger.list(h.adapter.sessionKey).length, 1);
  mapped(h.adapter, "original");
});

test("report 只接受当前 turn 且要求真实 reads；同 turn 同报告幂等，异报告和伪造旧 turn 拒绝", timeout, async t => {
  const reports: unknown[] = [];
  const h = await harness(t, [fauxAssistantMessage("完成")], { onReport: (_token, report) => { reports.push(report); return true; } });
  await (await h.adapter.submit({ requestId: "report-fence", text: "需要报告", inputIds: ["report-input"] })).completion;
  const good = { state: "ready" as const, summary: "同一轮已完成" };
  assert.equal(h.adapter.report(good), true);
  assert.equal(h.adapter.report(good), true, "同 turn 重复相同报告应幂等");
  assert.equal(h.adapter.report({ state: "failed", summary: "篡改同轮结果" }), false);
  assert.deepEqual(reports, [good]);
  const receipt = h.adapter.get("report-fence")!;
  assert.equal(receipt.reports.length, 1);
  assert.equal(receipt.stage, "reported");
  const read = receipt.reads.at(-1)!;
  const liveTurn = { requestId: receipt.requestId, turnId: read.turnId, requestIds: [receipt.requestId], reportingIds: [receipt.requestId], epoch: read.epoch, binding: read.binding };
  const forged = { ...liveTurn, turnId: "forged-old-turn" };
  assert.equal(h.adapter.report(good, forged), false);
  assert.equal(reports.length, 1, "拒绝的旧 turn 不得再次触发 onReport");
});


test("assistant prose 中声称 ready 不替代 dsh_report 工具回执", timeout, async t => {
  const reports: unknown[] = [];
  const h = await harness(t, [fauxAssistantMessage('{"state":"ready","summary":"文字中的完成声明"}')], { onReport: (_token, report) => { reports.push(report); } });
  await (await h.adapter.submit({ requestId: "prose", text: "执行工作" })).completion;
  assert.equal(mapped(h.adapter, "prose").receipt.stage, "read");
  assert.deepEqual(h.adapter.get("prose")!.reports, []); assert.deepEqual(reports, []);
});

test("真实 SDK 缺少 model 的 preflight 拒绝落 rejected 回执，recover 不重投", timeout, async t => {
  const h = await harness(t, [fauxAssistantMessage("不应请求")]);
  const model = h.adapter.session.agent.state.model;
  h.adapter.session.agent.state.model = undefined as never;
  await assert.rejects(h.adapter.submit({ requestId: "rejected", text: "缺模型" }));
  const receipt = h.adapter.get("rejected")!;
  assert.equal(receipt.status, "rejected"); assert.equal(receipt.entryId, undefined); assert.deepEqual(receipt.reads, []);
  h.adapter.session.agent.state.model = model;
  const recovered = await h.adapter.recover("rejected"); await recovered.completion;
  assert.equal(h.faux.state.callCount, 0); assert.equal(h.adapter.get("rejected")!.status, "rejected");
});

test("同 session 的第二独立连接不能夺走活 owner，失败打开不破坏原 owner", timeout, async t => {
  const h = await harness(t, [fauxAssistantMessage("原 owner 仍可运行")]);
  const second = openShadowStore(h.file); t.after(() => second.close());
  await assert.rejects(h.open({ store: second }), /owner/i);
  await (await h.adapter.submit({ requestId: "owner", text: "原 owner 工作" })).completion;
  assert.equal(mapped(h.adapter, "owner").receipt.stage, "read");
});

test("onReport 拒绝的真实 tool 调用不得在 reconcile/重开时被补造成 accepted report", timeout, async t => {
  const h = await harness(t, [fauxAssistantMessage([fauxToolCall("dsh_report", { state: "ready", summary: "外层拒绝" })], { stopReason: "toolUse" }), fauxAssistantMessage("结束")], { onReport: () => false });
  assert.ok(h.adapter.session.getActiveToolNames().includes("dsh_report"));
  await (await h.adapter.submit({ requestId: "refused-report", text: "报告" })).completion;
  const toolResults = entries(h.adapter).filter(entry => entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolName === "dsh_report");
  assert.equal(toolResults.length, 1); assert.match(JSON.stringify(toolResults[0]), /refused|拒绝/i);
  const receipt = mapped(h.adapter, "refused-report").receipt;
  assert.equal(receipt.stage, "read"); assert.deepEqual(receipt.reports, []);
  const reopened = await h.restart();
  assert.equal(reopened.get("refused-report")!.stage, "read");
  assert.deepEqual(reopened.get("refused-report")!.reports, []);
});

test("rebind 中止旧 run 后拒绝旧 epoch 的迟到报告，旧 queued 输入不进入新 Assignment", timeout, async t => {
  const entered = deferred();
  const reports: unknown[] = [];
  const h = await harness(t, [async (_context, options) => {
    entered.resolve();
    await new Promise<void>(done => {
      if (options?.signal?.aborted) done();
      else options?.signal?.addEventListener("abort", () => done(), { once: true });
    });
    return fauxAssistantMessage([fauxToolCall("dsh_report", { state: "ready", summary: "迟到报告" })], { stopReason: "toolUse" });
  }, fauxAssistantMessage("新 Assignment 工作")], { onReport: (_token, report) => { reports.push(report); return true; } });
  const first = await h.adapter.submit({ requestId: "old-running", text: "旧 Assignment" }); await entered.promise;
  const queued = await h.adapter.submit({ requestId: "old-queued", text: "旧排队输入", mode: "followUp" });
  const newer = { ...binding, assignmentId: "new-assignment", generation: 2, claimToken: 2 };
  await h.adapter.rebind(newer); await first.completion.catch(() => {}); await queued.completion.catch(() => {});
  assert.equal(h.adapter.report({ state: "ready", summary: "旧 turn 迟到回调" }), false);
  assert.deepEqual(reports, []); assert.equal(h.adapter.get("old-queued")!.status, "uncertain");
  await (await h.adapter.submit({ requestId: "new-running", text: "新输入" })).completion;
  assert.deepEqual(mapped(h.adapter, "new-running").receipt.binding, newer);
  assert.equal(h.adapter.get("old-queued")!.entryId, undefined); assert.deepEqual(reports, []);
});

for (const hook of ["onRead", "onPersisted"] as const) test(`${hook} 异步作用域显式 adapter.submit 保留新 request 身份`, timeout, async t => {
  let adapter!: ScratchPiSession;
  let submitted: ReturnType<ScratchPiSession["submit"]> | undefined;
  const h = await harness(t, [fauxAssistantMessage("原始回复"), fauxAssistantMessage("显式新请求回复")], {
    [hook]: (_token: WorkerToken, ids: string[]) => {
      if (ids.includes("original-input") && !submitted) {
        submitted = adapter.submit({ requestId: "explicit", text: "EXPLICIT_FROM_ON_READ", inputIds: ["explicit-input"], mode: "followUp" });
      }
    },
  });
  adapter = h.adapter;
  const original = await adapter.submit({ requestId: "original", text: "ORIGINAL_INPUT", inputIds: ["original-input"] });
  await original.completion;
  assert.ok(submitted);
  await (await submitted).completion;
  assert.match(JSON.stringify(mapped(adapter, "original").entry.message.content), /ORIGINAL_INPUT/);
  const explicit = mapped(adapter, "explicit");
  assert.match(JSON.stringify(explicit.entry.message.content), /EXPLICIT_FROM_ON_READ/);
  assert.equal(explicit.receipt.stage, "read");
  assert.equal(users(adapter).length, 2);
  assert.equal(adapter.ledger.list(adapter.sessionKey).length, 2);
});

test("before_agent_start 内嵌 SDK prompt 不继承外层 request tag", timeout, async t => {
  let nested = false;
  const extension: ExtensionFactory = pi => {
    pi.on("before_agent_start", async () => {
      if (!nested) {
        nested = true;
        await pi.sendUserMessage("DERIVED_BEFORE_START", { deliverAs: "followUp" });
      }
    });
  };
  const h = await harness(t, [fauxAssistantMessage("嵌套完成"), fauxAssistantMessage("原始完成")], { extensions: [extension] });
  await (await h.adapter.submit({ requestId: "outer", text: "ORIGINAL_BEFORE_START" })).completion;
  assert.match(JSON.stringify(mapped(h.adapter, "outer").entry.message.content), /ORIGINAL_BEFORE_START/);
  const derived = users(h.adapter).filter(entry => JSON.stringify(entry.message.content).includes("DERIVED_BEFORE_START"));
  assert.equal(derived.length, 1);
  assert.equal(derived[0].message.__fastvibeDsh, undefined);
  assert.equal(h.adapter.ledger.list(h.adapter.sessionKey).length, 1);
});

test("已 persisted 但 context hook 过滤的输入不能用 report 冒充真实 reads", timeout, async t => {
  const reports: unknown[] = [];
  const extension: ExtensionFactory = pi => { pi.on("context", event => ({ messages: event.messages.filter(message => message.role !== "user") })); };
  const h = await harness(t, [fauxAssistantMessage([fauxToolCall("dsh_report", { state: "ready", summary: "未读输入不能报告" })], { stopReason: "toolUse" }), fauxAssistantMessage("结束")], {
    extensions: [extension], onReport: (_token, report) => { reports.push(report); return true; },
  });
  await (await h.adapter.submit({ requestId: "filtered-report", text: "需要真正阅读", inputIds: ["filtered"] })).completion;
  const receipt = mapped(h.adapter, "filtered-report").receipt;
  assert.equal(receipt.stage, "persisted");
  assert.deepEqual(receipt.reads, []);
  assert.deepEqual(receipt.reports, []);
  assert.deepEqual(reports, []);
  const results = entries(h.adapter).filter(entry => entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolName === "dsh_report");
  assert.equal(results.length, 1);
  assert.equal(results[0].message.isError, true);
});

test("真实上一 turn 的 captured report 在下一 turn 活跃时被拒绝", timeout, async t => {
  const gate = deferred(); t.after(gate.resolve);
  const reports: unknown[] = [];
  const h = await harness(t, [fauxAssistantMessage("第一轮"), async () => { await gate.promise; return fauxAssistantMessage("第二轮"); }], {
    onReport: (_token, report) => { reports.push(report); return true; },
  });
  await (await h.adapter.submit({ requestId: "first-turn", text: "第一轮要求" })).completion;
  const read = h.adapter.get("first-turn")!.reads.at(-1)!;
  const captured = { requestId: "first-turn", requestIds: ["first-turn"], reportingIds: ["first-turn"], turnId: read.turnId, epoch: read.epoch, binding: read.binding };
  const next = await h.adapter.submit({ requestId: "second-turn", text: "第二轮要求" });
  await until(() => h.faux.state.callCount === 2);
  assert.equal(h.adapter.report({ state: "ready", summary: "迟到第一轮" }, captured), false);
  assert.deepEqual(reports, []);
  assert.equal(h.adapter.report({ state: "ready", summary: "当前轮" }), true);
  assert.equal(reports.length, 1);
  gate.resolve(); await next.completion;
});

for (const initial of ["progress", "waiting"] as const) test(`真实 SDK ${initial} 报告后 Continue 可在新 turn 报 ready，已 reported 输入仍有新 read`, timeout, async t => {
  const reports: unknown[] = [];
  const firstReport = { state: initial, summary: "第一轮状态" };
  const ready = { state: "ready" as const, summary: "继续后完成" };
  const h = await harness(t, [
    fauxAssistantMessage([fauxToolCall("dsh_report", firstReport)], { stopReason: "toolUse" }),
    fauxAssistantMessage([fauxToolCall("dsh_report", ready)], { stopReason: "toolUse" }),
  ], { onReport: (_token, report) => { reports.push(report); return true; } });
  await (await h.adapter.submit({ requestId: "continued-report", text: "分阶段完成", inputIds: ["work"] })).completion;
  const first = mapped(h.adapter, "continued-report").receipt;
  assert.equal(first.stage, "reported"); assert.deepEqual(reports, [firstReport]);
  assert.equal(h.adapter.report(firstReport), true);
  assert.equal(h.adapter.report(ready), false, "同 turn 的异报告仍拒绝");
  await h.adapter.continue();
  const receipt = h.adapter.get("continued-report")!;
  assert.deepEqual(reports, [firstReport, ready]);
  assert.deepEqual(receipt.reports.map(record => record.report), [firstReport, ready]);
  assert.notEqual(receipt.reports[0]!.turnId, receipt.reports[1]!.turnId);
  assert.ok(receipt.reads.some(read => read.turnId === receipt.reports[1]!.turnId));
  assert.ok(receipt.reads.length > first.reads.length);
  assert.equal(h.adapter.report(ready), true); assert.equal(reports.length, 2);
  assert.equal(users(h.adapter).length, 1, "Continue 不补 user");
});

for (const refusal of ["false", "async"] as const) test(`report callback ${refusal} 不得留下部分 SQL、receipt 或 REPORT mirror`, timeout, async t => {
  const h = await harness(t, [fauxAssistantMessage("已读")], { onReport: () => {
    h.store.set("veto-side-effect", true);
    h.store.afterCommit(() => { throw new Error("refused callback must not commit"); });
    return refusal === "false" ? false : Promise.resolve() as unknown as void;
  } });
  await (await h.adapter.submit({ requestId: "veto", text: "需同步接受" })).completion;
  const before = h.adapter.get("veto")!;
  const journal = readFileSync(h.adapter.session.sessionFile!, "utf8");
  const report = { state: "ready" as const, summary: "拒绝接受" };
  if (refusal === "false") assert.equal(h.adapter.report(report), false);
  else assert.throws(() => h.adapter.report(report), /只允许同步/);
  assert.equal(h.store.get("veto-side-effect"), undefined);
  assert.deepEqual(h.adapter.get("veto"), before);
  assert.equal(readFileSync(h.adapter.session.sessionFile!, "utf8"), journal);
  const reopened = await h.restart();
  assert.deepEqual(reopened.get("veto"), before);
  assert.equal(h.faux.state.callCount, 1);
});

test("outer atomic 回滚 report 时 domain SQL、ledger 与 REPORT mirror 全部不留存", timeout, async t => {
  let callbackCalls = 0;
  const h = await harness(t, [fauxAssistantMessage("已读取")], { onReport: (_token, report) => {
    callbackCalls++;
    h.store.set("report-domain", report);
    return true;
  } });
  await (await h.adapter.submit({ requestId: "atomic-report", text: "原子报告", inputIds: ["work"] })).completion;
  const before = h.adapter.get("atomic-report")!;
  const journal = readFileSync(h.adapter.session.sessionFile!, "utf8");
  const report = { state: "ready" as const, summary: "事务内报告" };
  const observer = openShadowStore(h.file); t.after(() => observer.close());
  assert.throws(() => h.store.atomic(() => {
    assert.equal(h.adapter.report(report), true);
    assert.equal(h.adapter.get("atomic-report")!.stage, "reported");
    assert.deepEqual(h.store.get("report-domain"), report);
    assert.equal(observer.get("report-domain"), undefined);
    assert.equal(observer.sessionReceipts.get(h.adapter.sessionKey, "atomic-report")!.stage, "read");
    assert.equal(readFileSync(h.adapter.session.sessionFile!, "utf8"), journal, "未 commit 不得追加 REPORT");
    throw new Error("outer rollback");
  }), /outer rollback/);
  assert.equal(callbackCalls, 1, "回调真实执行，其 SQL 写入必须被外层回滚");
  assert.equal(h.store.get("report-domain"), undefined);
  assert.deepEqual(h.adapter.get("atomic-report"), before);
  assert.equal(readFileSync(h.adapter.session.sessionFile!, "utf8"), journal);
  const reopened = await h.restart();
  assert.deepEqual(reopened.get("atomic-report")!.reports, []);
  assert.equal(callbackCalls, 1); assert.equal(h.faux.state.callCount, 1);
});

for (const forgery of ["unaccepted", "mismatched"] as const) test(`JSONL ${forgery} REPORT 不能恢复或篡改 accepted，重开 fail closed`, timeout, async t => {
  let reports = 0;
  const h = await harness(t, [fauxAssistantMessage("已读")], { onReport: () => { reports++; return true; } });
  await (await h.adapter.submit({ requestId: "forged-report", text: "真实输入" })).completion;
  if (forgery === "mismatched") assert.equal(h.adapter.report({ state: "progress", summary: "DB 已接受" }), true);
  const before = h.adapter.get("forged-report")!;
  const read = before.reads.at(-1)!;
  h.adapter.session.sessionManager.appendCustomEntry("fastvibe-dsh-report", {
    sessionKey: h.adapter.sessionKey, epoch: read.epoch, binding: read.binding, turnId: read.turnId,
    requestIds: ["forged-report"], at: Date.now(), report: { state: "ready", summary: "伪造 JSONL 接受" },
  });
  await h.adapter.dispose();
  await assert.rejects(h.open(), /no committed acceptance|reconciliation required/);
  assert.deepEqual(h.adapter.get("forged-report"), before);
  assert.equal(reports, forgery === "mismatched" ? 1 : 0);
  assert.equal(h.faux.state.callCount, 1);
});

test("SDK runtime stream 入口在返回 stream 前同步 throw，不产生假 READ marker、read ledger 或 onRead", timeout, async t => {
  let providerCalls = 0, reads = 0;
  const h = await harness(t, [], { onRead: () => { reads++; } }, () => {
    providerCalls++; throw new Error("synchronous provider failure");
  });
  const result = await h.adapter.submit({ requestId: "provider-throw", text: "必须真正发出才算读", inputIds: ["unread"] });
  await result.completion.catch(() => {});
  const receipt = mapped(h.adapter, "provider-throw").receipt;
  assert.equal(providerCalls, 1); assert.equal(reads, 0);
  assert.equal(receipt.stage, "persisted"); assert.deepEqual(receipt.reads, []);
  assert.equal(entries(h.adapter).some(entry => entry.type === "custom" && entry.customType === "fastvibe-dsh-read"), false);
  assert.equal(h.adapter.report({ state: "ready", summary: "不能报告未读输入" }), false);
  const reopened = await h.restart();
  assert.equal(reopened.get("provider-throw")!.stage, "persisted");
  assert.deepEqual(reopened.get("provider-throw")!.reads, []); assert.equal(providerCalls, 1);
});

test("running 同 token rebind 幂等，不中止 run、不清 queued、不递增 epoch", timeout, async t => {
  const gate = deferred(); t.after(gate.resolve);
  let aborted = false;
  const h = await harness(t, [async (_context, options) => {
    options?.signal?.addEventListener("abort", () => { aborted = true; }, { once: true });
    await gate.promise; return fauxAssistantMessage("原运行完成");
  }, fauxAssistantMessage("队列完成")]);
  const first = await h.adapter.submit({ requestId: "same-token-running", text: "继续运行" });
  await until(() => h.faux.state.callCount === 1);
  const queued = await h.adapter.submit({ requestId: "same-token-queued", text: "保留队列", mode: "followUp" });
  const state = h.adapter.ledger.session(h.adapter.sessionKey)!;
  await h.adapter.rebind({ ...binding });
  assert.deepEqual(h.adapter.ledger.session(h.adapter.sessionKey), state);
  assert.equal(aborted, false); assert.equal(h.adapter.session.isIdle, false);
  assert.equal(h.adapter.get("same-token-queued")!.status, "queued");
  gate.resolve(); await Promise.all([first.completion, queued.completion]);
  assert.equal(h.faux.state.callCount, 2); assert.equal(users(h.adapter).length, 2);
  assert.equal(mapped(h.adapter, "same-token-queued").receipt.stage, "read");
});

test("Stop 后同 token 与新 token rebind 都继承 paused，submit 拒绝直到显式 resume", timeout, async t => {
  const h = await harness(t, [fauxAssistantMessage("原工作"), fauxAssistantMessage("恢复后工作")]);
  await (await h.adapter.submit({ requestId: "before-pause", text: "原工作" })).completion;
  await h.adapter.stop();
  const stopped = h.adapter.ledger.session(h.adapter.sessionKey)!;
  await h.adapter.rebind({ ...binding });
  assert.deepEqual(h.adapter.ledger.session(h.adapter.sessionKey), stopped);
  await assert.rejects(h.adapter.submit({ requestId: "same-paused", text: "不能自动恢复" }), /stopped|superseded/);
  const newer = { ...binding, assignmentId: "paused-new-assignment", generation: 2, claimToken: 4 };
  await h.adapter.rebind(newer);
  assert.equal(h.adapter.ledger.session(h.adapter.sessionKey)!.paused, true);
  await assert.rejects(h.adapter.submit({ requestId: "new-paused", text: "仍不能自动恢复" }), /stopped|superseded/);
  assert.equal(h.adapter.get("same-paused"), undefined); assert.equal(h.adapter.get("new-paused"), undefined);
  assert.equal(h.faux.state.callCount, 1);
  await h.adapter.resume(); assert.equal(h.faux.state.callCount, 1);
  await (await h.adapter.submit({ requestId: "resumed", text: "显式恢复后的输入" })).completion;
  assert.deepEqual(mapped(h.adapter, "resumed").receipt.reads.at(-1)!.binding, newer);
  assert.equal(h.faux.state.callCount, 2);
});

for (const cleanup of ["dispose", "rebind"] as const) test(`Stop 后 ${cleanup} 不覆盖已 stopped 队列回执且保持 paused，重开不恢复`, timeout, async t => {
  const entered = deferred();
  const h = await harness(t, [async (_context, options) => {
    entered.resolve();
    await new Promise<void>(done => {
      if (options?.signal?.aborted) done();
      else options?.signal?.addEventListener("abort", () => done(), { once: true });
    });
    return fauxAssistantMessage("被 Stop 中止");
  }]);
  const running = await h.adapter.submit({ requestId: "stop-running", text: "运行" }); await entered.promise;
  const queued = await h.adapter.submit({ requestId: "stop-queued", text: "人工停止的队列", mode: "followUp" });
  await h.adapter.stop(); await Promise.all([running.completion.catch(() => {}), queued.completion.catch(() => {})]);
  assert.equal(h.adapter.get("stop-queued")!.status, "stopped");
  const newer = { ...binding, assignmentId: "after-stop", generation: 2, claimToken: 8 };
  if (cleanup === "dispose") await h.adapter.dispose(); else await h.adapter.rebind(newer);
  assert.equal(h.adapter.get("stop-queued")!.status, "stopped");
  assert.equal(h.adapter.ledger.session(h.adapter.sessionKey)!.paused, true);
  await h.adapter.dispose();
  const reopened = await h.open({ binding: cleanup === "rebind" ? newer : binding });
  assert.equal(reopened.get("stop-queued")!.status, "stopped");
  assert.equal(reopened.ledger.session(reopened.sessionKey)!.paused, true);
  await assert.rejects(reopened.submit({ requestId: "blocked-after-reopen", text: "仍暂停" }));
  await reopened.resume();
  await (await reopened.recover("stop-queued")).completion;
  assert.equal(reopened.get("stop-queued")!.entryId, undefined);
  assert.equal(h.faux.state.callCount, 1); assert.equal(users(reopened).length, 1);
});

test("异步 preflight 遭 rebind 失效后记 uncertain，同实例显式 recover 以新 binding 真正读取一次", timeout, async t => {
  const entered = deferred(), release = deferred(); t.after(release.resolve);
  let first = true;
  const extension: ExtensionFactory = pi => { pi.on("before_agent_start", async () => {
    if (first) { first = false; entered.resolve(); await release.promise; }
  }); };
  const h = await harness(t, [fauxAssistantMessage("恢复后执行")], { extensions: [extension] });
  const pending = h.adapter.submit({ requestId: "preflight-recover", text: "尚未落盘的输入", inputIds: ["preflight-input"] });
  const outcome = pending.then(result => ({ result }), error => ({ error }));
  await entered.promise;
  const newer = { ...binding, assignmentId: "preflight-new", generation: 2, claimToken: 5 };
  const rebinding = h.adapter.rebind(newer);
  await until(() => h.adapter.ledger.session(h.adapter.sessionKey)!.epoch > h.adapter.get("preflight-recover")!.epoch);
  release.resolve(); await rebinding;
  const failed = await outcome;
  if ("result" in failed) await failed.result.completion.catch(() => {});
  await h.adapter.session.waitForIdle();
  const old = h.adapter.get("preflight-recover")!;
  assert.equal(old.status, "uncertain"); assert.equal(old.entryId, undefined); assert.deepEqual(old.reads, []);
  assert.equal(h.faux.state.callCount, 0);
  await (await h.adapter.recover("preflight-recover")).completion;
  const recovered = mapped(h.adapter, "preflight-recover").receipt;
  assert.deepEqual(recovered.binding, binding);
  assert.deepEqual(recovered.reads.at(-1)!.binding, newer);
  assert.equal(users(h.adapter).length, 1); assert.equal(h.faux.state.callCount, 1);
});

for (const pathKind of ["base", "workspace", "agent", "sessions", "file"] as const) test(`scratch 内部 ${pathKind} 指向另一个 tmp 的 symlink 仍拒绝`, timeout, async t => {
  const h = await harness(t, [fauxAssistantMessage("持久历史")]);
  await (await h.adapter.submit({ requestId: "before-link", text: "原始历史" })).completion;
  const state = h.adapter.ledger.session(h.adapter.sessionKey)!;
  const base = dirname(dirname(state.sessionFile));
  const path = pathKind === "base" ? base : pathKind === "file" ? state.sessionFile : join(base, pathKind);
  const external = mkdtempSync(join(tmpdir(), "vivi-dsh-link-target-"));
  t.after(() => rmSync(external, { recursive: true, force: true }));
  await h.adapter.dispose();
  const destination = join(external, "original");
  renameSync(path, destination);
  symlinkSync(destination, path);
  const history = pathKind === "file" ? readFileSync(destination, "utf8") : undefined;
  await assert.rejects(h.open(), /symbolic links/);
  if (history !== undefined) assert.equal(readFileSync(destination, "utf8"), history);
});

test("真实子进程在 report SQL commit 后 mirror 前退出，DB accepted 保留且重开不运行、不重放 onReport", timeout, async t => {
  let replayedReports = 0;
  const h = await harness(t, [fauxAssistantMessage("预热持久历史")], { onReport: () => { replayedReports++; return true; } });
  await (await h.adapter.submit({ requestId: "warmup", text: "建立真实 SDK 历史" })).completion;
  const file = h.adapter.session.sessionFile!;
  await h.adapter.dispose();
  const fixture = fileURLToPath(new URL("./fixtures/vivi-dsh-pi-crash.ts", import.meta.url));
  const child = spawn(process.execPath, [fixture, h.root, "report-committed-before-mirror"], { cwd: h.root, stdio: ["ignore", "pipe", "pipe"] });
  t.after(() => { if (child.exitCode === null) child.kill("SIGKILL"); });
  let output = "";
  child.stdout.on("data", chunk => { output += chunk; }); child.stderr.on("data", chunk => { output += chunk; });
  const exit = await new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("exit", resolve); });
  assert.equal(exit, 74, output);
  const committed = h.adapter.get("warmup")!;
  assert.equal(committed.stage, "reported"); assert.equal(committed.reports.length, 1);
  assert.deepEqual(committed.reports[0]!.report, { state: "ready", summary: "SQL 已提交但 mirror 尚未追加" });
  assert.deepEqual(h.store.get("crash-report-domain"), committed.reports[0]!.report);
  assert.equal(h.store.get("crash-report-calls"), 1);
  assert.doesNotMatch(readFileSync(file, "utf8"), /fastvibe-dsh-report/);
  const reopened = await h.open();
  assert.deepEqual(reopened.get("warmup"), committed);
  assert.equal((await reopened.submit({ requestId: "warmup", text: "建立真实 SDK 历史" })).reused, true);
  await (await reopened.recover("warmup")).completion;
  assert.equal(h.faux.state.callCount, 1); assert.equal(replayedReports, 0);
  assert.equal(h.store.get("crash-report-calls"), 1); assert.equal(users(reopened).length, 1);
});

for (const mode of ["accepted", "jsonl-before-receipt", "receipt"] as const) test(`真实子进程在 ${mode} 窗口退出，重开只 reconcile；缺失输入显式 recover`, timeout, async t => {
  const h = await harness(t, [fauxAssistantMessage("预热持久历史"), fauxAssistantMessage("恢复后完成")]);
  await (await h.adapter.submit({ requestId: "warmup", text: "建立真实 SDK 历史" })).completion;
  await h.adapter.dispose();
  const fixture = fileURLToPath(new URL("./fixtures/vivi-dsh-pi-crash.ts", import.meta.url));
  const child = spawn(process.execPath, [fixture, h.root, mode], { cwd: h.root, stdio: ["ignore", "pipe", "pipe"] });
  t.after(() => { if (child.exitCode === null) child.kill("SIGKILL"); });
  let output = "";
  child.stdout.on("data", chunk => { output += chunk; }); child.stderr.on("data", chunk => { output += chunk; });
  const exit = await new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("exit", resolve); });
  assert.equal(exit, mode === "accepted" ? 71 : mode === "jsonl-before-receipt" ? 72 : 73, output);
  const before = h.store.sessionReceipts.get(`worker-${binding.ticketId}`, "crash");
  assert.ok(before); assert.equal(Boolean(before.entryId), mode === "receipt");
  const reopened = await h.open();
  assert.equal(h.faux.state.callCount, 1, "重开不能自动请求模型");
  const receipt = reopened.get("crash")!;
  if (mode === "accepted") {
    assert.equal(receipt.entryId, undefined); assert.deepEqual(receipt.reads, []);
    await reopened.recover("crash"); await reopened.session.waitForIdle();
    assert.equal(h.faux.state.callCount, 2);
    assert.equal(mapped(reopened, "crash").receipt.stage, "read");
    assert.equal(users(reopened).filter(entry => entry.message.__fastvibeDsh?.requestId === "crash").length, 1);
  } else {
    assert.ok(mapped(reopened, "crash").entry.id);
    assert.equal(receipt.stage, "persisted", "没有 provider 请求证据时不能补造 read");
    assert.deepEqual(receipt.reads, []);
    // Replaying an existing id is idempotent even if death interrupted its run.
    assert.equal((await reopened.submit({ requestId: "crash", text: "CRASH_INPUT", inputIds: ["crash-input"] })).reused, true);
    assert.equal(h.faux.state.callCount, 1);
    assert.equal(users(reopened).filter(entry => entry.message.__fastvibeDsh?.requestId === "crash").length, 1);
  }
});

test("JSONL-before-receipt 崩溃后以新 Assignment 重开仅恢复原 dispatch 身份，不冒充新 binding 回调或重复投递", timeout, async t => {
  const persisted: { token: WorkerToken; ids: string[] }[] = [];
  const h = await harness(t, [fauxAssistantMessage("预热持久历史")], {
    onPersisted: (token, ids) => { persisted.push({ token, ids }); },
  });
  await (await h.adapter.submit({ requestId: "warmup", text: "建立真实 SDK 历史" })).completion;
  const file = h.adapter.session.sessionFile!;
  await h.adapter.dispose();
  const fixture = fileURLToPath(new URL("./fixtures/vivi-dsh-pi-crash.ts", import.meta.url));
  const child = spawn(process.execPath, [fixture, h.root, "jsonl-before-receipt"], { cwd: h.root, stdio: ["ignore", "pipe", "pipe"] });
  t.after(() => { if (child.exitCode === null) child.kill("SIGKILL"); });
  let output = "";
  child.stdout.on("data", chunk => { output += chunk; }); child.stderr.on("data", chunk => { output += chunk; });
  const exit = await new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("exit", resolve); });
  assert.equal(exit, 72, output);
  const before = h.store.sessionReceipts.get(h.adapter.sessionKey, "crash")!;
  assert.ok(before); assert.equal(before.entryId, undefined);
  const history = readFileSync(file, "utf8");
  const rawUsers = history.trim().split("\n").map(line => JSON.parse(line)).filter(entry => entry.type === "message" && entry.message.role === "user");
  const original = rawUsers.find(entry => entry.message.__fastvibeDsh?.requestId === "crash");
  assert.ok(original);
  const tag = original.message.__fastvibeDsh;
  assert.deepEqual(tag.binding, binding);
  assert.equal(tag.epoch, before.epoch);
  persisted.length = 0;
  const newer = { ...binding, assignmentId: "reopened-assignment-B", generation: 2, claimToken: 9 };
  const reopened = await h.open({ binding: newer });
  const recovered = mapped(reopened, "crash").receipt;
  assert.equal(recovered.entryId, original.id);
  assert.equal(recovered.entryEpoch, tag.epoch);
  assert.deepEqual(recovered.entryBinding, binding);
  assert.deepEqual(recovered.binding, binding);
  assert.deepEqual(reopened.ledger.session(reopened.sessionKey)!.binding, newer);
  assert.deepEqual(persisted, [], "历史 A 的 entry 不得用打开者 B 的身份发 onPersisted");
  assert.deepEqual(recovered.reads, []);
  const replay = await reopened.recover("crash"); await replay.completion;
  assert.equal(replay.reused, true);
  assert.deepEqual(reopened.get("crash"), recovered);
  assert.equal(h.faux.state.callCount, 1, "重开与 recover 均不得开启模型");
  assert.equal(users(reopened).filter(entry => entry.message.__fastvibeDsh?.requestId === "crash").length, 1);
  assert.equal(readFileSync(file, "utf8"), history, "恢复不能追加重复 user 或伪造 read");
  assert.deepEqual(persisted, []);
});

for (const field of ["requestId", "epoch", "binding"] as const) test(`持久 receipt 对应 JSONL tag.${field} 被篡改时重开 failclosed，保留原 entry.id`, timeout, async t => {
  let persisted = 0;
  const h = await harness(t, [fauxAssistantMessage("真实持久输入")], { onPersisted: () => { persisted++; } });
  await (await h.adapter.submit({ requestId: "original", text: "不可改变投递身份" })).completion;
  const { receipt, entry } = mapped(h.adapter, "original");
  const file = h.adapter.session.sessionFile!;
  await h.adapter.dispose();
  const rows = entries(h.adapter);
  const target = rows.find(row => row.id === receipt.entryId)!;
  assert.equal(target.id, entry.id);
  const tag = target.message.__fastvibeDsh;
  if (field === "requestId") tag.requestId = "forged-request";
  else if (field === "epoch") tag.epoch = receipt.entryEpoch! + 1;
  else tag.binding = { ...receipt.entryBinding!, assignmentId: "forged-assignment" };
  writeFileSync(file, rows.map(row => JSON.stringify(row)).join("\n") + "\n");
  const corrupted = readFileSync(file, "utf8");
  persisted = 0;
  await assert.rejects(h.open(), /unregistered DSH request|entry identity is inconsistent/);
  assert.deepEqual(h.store.sessionReceipts.get(h.adapter.sessionKey, "original"), receipt);
  assert.equal(persisted, 0);
  assert.equal(h.faux.state.callCount, 1);
  assert.equal(readFileSync(file, "utf8"), corrupted, "failclosed 不得重写或修正损坏证据");
  assert.equal(JSON.parse(corrupted.trim().split("\n").find(line => JSON.parse(line).id === receipt.entryId)!).id, entry.id);
});
