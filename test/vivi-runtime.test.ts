import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createFauxCore, fauxAssistantMessage, fauxToolCall, InMemoryModelsStore } from "@earendil-works/pi-ai";
import { openShadowStore } from "../src/main/bot/shadow/store.ts";
import { ViviRuntime } from "../src/main/bot/shadow/vivi-runtime.ts";

async function provider(root: string) {
  const faux = createFauxCore({ api: "viviapi", provider: "vivi", models: [{ id: "offline" }] });
  faux.setResponses([fauxAssistantMessage([fauxToolCall("vivi_report", { state: "ready", summary: "ready" })], { stopReason: "toolUse" })]);
  const modelRuntime = await ModelRuntime.create({ authPath: join(root, "auth.json"), modelsPath: null,
    modelsStore: new InMemoryModelsStore(), allowModelNetwork: false, refreshOnCreate: false });
  modelRuntime.registerProvider("vivi", { baseUrl: "http://offline.invalid", api: "viviapi" as never, apiKey: "offline", streamSimple: faux.streamSimple as never,
    models: [{ id: "offline", name: "offline", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100_000, maxTokens: 4096 }] });
  return { faux, modelRuntime, model: modelRuntime.getModel("vivi", "offline")! };
}

function harness(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), "viviruntime-"));
  const store = openShadowStore(join(root, "shadow.db"));
  const runtimes: ViviRuntime[] = [];
  t.after(async () => { for (const runtime of runtimes) await runtime.stop(); store.close(); rmSync(root, { recursive: true, force: true }); });
  return { root, store, runtimes };
}

test("构造 runtime 不启动 Pass 或 SDK Worker", async t => {
  const h = harness(t); const p = await provider(h.root);
  const runtime = new ViviRuntime({ store: h.store, root: join(h.root, "workers"), modelRuntime: p.modelRuntime, model: p.model, maxWorkers: () => 1 });
  assert.equal(p.faux.state.callCount, 0);
  assert.deepEqual(runtime.tickets(), []);
  await runtime.stop();
});

test("显式 local request 完成 Ticket/Assignment/真实 SDK ready report", async t => {
  const h = harness(t); const p = await provider(h.root);
  const runtime = new ViviRuntime({ store: h.store, root: join(h.root, "workers"), modelRuntime: p.modelRuntime, model: p.model, maxWorkers: () => 1 });
  h.runtimes.push(runtime);
  const ticketId = runtime.submit({ requestId: "request-1", text: "Create the requested file", title: "Create file", scope: "workspace" });
  assert.equal(runtime.submit({ requestId: "request-1", text: "Create the requested file", title: "Create file", scope: "workspace" }), ticketId);
  await runtime.start(); await runtime.idle();
  const ticket = runtime.ticket(ticketId)!;
  assert.equal(ticket.assignments.length, 1);
  assert.equal(ticket.assignments[0]!.report?.state, "ready");
  assert.equal(ticket.assignments[0]!.report?.summary, "ready");
  assert.equal(p.faux.state.callCount, 1);
  assert.equal(h.store.triggers.get("local:request-1")?.actor.id, "user");
  assert.equal(h.store.decisions.get(ticket.decisionId)?.kind, "accept");
  assert.throws(() => runtime.submit({ requestId: "request-1", text: "different" }), /payload/);
});

test("stop 后不执行，重开 ShadowStore 可读取领域事实", async t => {
  const root = mkdtempSync(join(tmpdir(), "viviruntime-reopen-"));
  const file = join(root, "shadow.db"); const p = await provider(root);
  const firstStore = openShadowStore(file); const first = new ViviRuntime({ store: firstStore, root: join(root, "workers"), modelRuntime: p.modelRuntime, model: p.model, maxWorkers: () => 1 });
  const ticketId = first.submit({ requestId: "request-stop", text: "Do work" });
  await first.stop();
  assert.equal(p.faux.state.callCount, 0);
  assert.throws(() => first.start(), /cannot restart/);
  assert.throws(() => first.submit({ requestId: "late", text: "must not run" }), /stopped/);
  await first.idle();
  assert.equal(p.faux.state.callCount, 0);
  firstStore.close();
  const reopened = openShadowStore(file); const second = new ViviRuntime({ store: reopened, root: join(root, "workers-2"), modelRuntime: p.modelRuntime, model: p.model, maxWorkers: () => 1 });
  t.after(async () => { await second.stop(); reopened.close(); rmSync(root, { recursive: true, force: true }); });
  assert.equal(second.ticket(ticketId)?.id, ticketId);
  assert.equal(second.submit({ requestId: "request-stop", text: "Do work" }), ticketId);
  await second.start(); await second.idle();
  assert.equal(p.faux.state.callCount, 1);
});

test("maxWorkers 为零时保持 pending，容量恢复后执行", async t => {
  const h = harness(t); const p = await provider(h.root);
  let capacity = 0;
  const runtime = new ViviRuntime({ store: h.store, root: join(h.root, "workers"), modelRuntime: p.modelRuntime, model: p.model, maxWorkers: () => capacity });
  h.runtimes.push(runtime);
  const id = runtime.submit({ requestId: "capacity", text: "work when capacity is available" });
  runtime.start(); await runtime.idle();
  assert.equal(p.faux.state.callCount, 0);
  assert.equal(runtime.ticket(id)?.assignments.at(-1)?.state, "pending");
  capacity = 1;
  await runtime.idle();
  assert.equal(runtime.ticket(id)?.assignments.at(-1)?.report?.state, "ready");
  assert.equal(p.faux.state.callCount, 1);
});

test("start 自动推进且 stop 等待真实 SDK 收尾并隔离迟到 report", { timeout: 15_000 }, async t => {
  const h = harness(t); const p = await provider(h.root);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  p.faux.setResponses([async () => { await gate; return fauxAssistantMessage([fauxToolCall("vivi_report", { state: "ready", summary: "late" })], { stopReason: "toolUse" }); }]);
  const runtime = new ViviRuntime({ store: h.store, root: join(h.root, "workers"), modelRuntime: p.modelRuntime, model: p.model, maxWorkers: () => 1 });
  h.runtimes.push(runtime);
  runtime.start();
  const id = runtime.submit({ requestId: "automatic", text: "work" });
  const until = async (check: () => boolean) => {
    const deadline = Date.now() + 8_000;
    while (!check()) {
      if (Date.now() > deadline) throw new Error("runtime did not progress");
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  };
  try {
    await until(() => p.faux.state.callCount === 1);
    const stopping = runtime.stop();
    release();
    await stopping;
    await runtime.idle();
    assert.notEqual(runtime.ticket(id)?.assignments.at(-1)?.report?.summary, "late");
    assert.equal(p.faux.state.callCount, 1);
  } finally { release(); }
});
