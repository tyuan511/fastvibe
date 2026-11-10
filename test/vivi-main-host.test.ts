import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createFauxCore, fauxAssistantMessage, fauxToolCall, InMemoryModelsStore } from "@earendil-works/pi-ai";
import { ViviMainHost, type ViviModelBinding } from "../src/main/bot/shadow/main-host.ts";
import { openShadowStore } from "../src/main/bot/shadow/store.ts";
import { registerBotIpc } from "../src/main/ipc/bot-handlers.ts";
import { dispatch } from "../src/main/ipc/registry.ts";
import { Ipc } from "../src/shared/ipc.ts";
import type { WorkSnapshot } from "../src/shared/bot.ts";

async function fixture(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), "vivi-main-host-"));
  const store = openShadowStore(join(root, "shadow.db"));
  const faux = createFauxCore({ api: "vivihostapi", provider: "vivihost", models: [{ id: "offline" }] });
  const modelRuntime = await ModelRuntime.create({ authPath: join(root, "auth.json"), modelsPath: null,
    modelsStore: new InMemoryModelsStore(), allowModelNetwork: false, refreshOnCreate: false });
  modelRuntime.registerProvider("vivihost", { baseUrl: "http://offline.invalid", api: "vivihostapi" as never, apiKey: "offline",
    streamSimple: faux.streamSimple as never, models: [{ id: "offline", name: "offline", reasoning: false, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100_000, maxTokens: 4096 }] });
  const binding: ViviModelBinding = { modelRuntime, model: modelRuntime.getModel("vivihost", "offline")! };
  const hosts: ViviMainHost[] = [];
  const host = (resolveModel: () => ViviModelBinding | undefined = () => binding) => {
    const value = new ViviMainHost({ store, root: join(root, "workers"), model: resolveModel, maxWorkers: () => 1 });
    hosts.push(value);
    return value;
  };
  const report = (summary: string) => fauxAssistantMessage([fauxToolCall("vivi_report", { state: "ready", summary })], { stopReason: "toolUse" });
  t.after(async () => { for (const value of hosts) await value.stop(); store.close(); rmSync(root, { recursive: true, force: true }); });
  return { root, store, faux, binding, host, report };
}

test("Main host without a model serves persisted snapshots and refuses execution without accepting input", async t => {
  const h = await fixture(t);
  let available = false;
  const host = h.host(() => available ? h.binding : undefined);
  assert.equal(host.start(), false);
  assert.deepEqual((await host.api.getWorkSnapshot()).conversations, []);
  await assert.rejects(host.api.submit({ requestId: "unavailable", text: "do work" }));
  assert.equal(h.store.tickets.list().length, 0);
  assert.equal(h.faux.state.callCount, 0);
  available = true;
  h.faux.setResponses([h.report("model is now available")]);
  assert.equal(host.start(), true);
  await host.api.submit({ requestId: "available", text: "do work" });
  await host.idle();
  assert.equal((await host.api.getWorkSnapshot()).results[0]?.status, "ready");
  assert.equal(h.faux.state.callCount, 1);
});

test("Main host reuses its supplied model runtime and starts a fresh owner after stop", async t => {
  const h = await fixture(t);
  const host = h.host();
  const api = host.api;
  h.faux.setResponses([h.report("first"), h.report("second")]);
  assert.equal(h.faux.state.callCount, 0);
  assert.equal(host.start(), true);
  await api.submit({ requestId: "one", text: "first task" });
  await host.idle();
  await host.stop();
  await assert.rejects(api.submit({ requestId: "stopped", text: "must not accept" }), /stopped/);
  assert.equal(h.store.tickets.list().length, 1);
  assert.equal(host.start(), true);
  assert.equal(host.api, api);
  await api.submit({ requestId: "two", text: "second task" });
  await host.idle();
  const snapshot = await api.getWorkSnapshot();
  assert.equal(snapshot.results.length, 2);
  assert.ok(snapshot.results.every(result => result.status === "ready"));
  assert.equal(h.faux.state.callCount, 2);
  // The caller's runtime still owns its registered provider after a host stop.
  await host.stop();
  assert.equal(h.binding.modelRuntime.getModel("vivihost", "offline")?.id, "offline");
});

test("Main host stop waits for provider cleanup and fences a late ready report", { timeout: 15_000 }, async t => {
  const h = await fixture(t);
  let dispatched!: () => void;
  const entered = new Promise<void>(resolve => { dispatched = resolve; });
  let finish!: () => void;
  const gate = new Promise<void>(resolve => { finish = resolve; });
  h.faux.setResponses([async () => { dispatched(); await gate; return h.report("stale result"); }]);
  const host = h.host();
  host.start();
  await host.api.submit({ requestId: "stop", text: "work" });
  try {
    await entered;
    const stopping = host.stop();
    assert.throws(() => host.start(), /stopping/);
    finish();
    await stopping;
    const snapshot = await host.api.getWorkSnapshot();
    assert.ok(snapshot.results.every(result => result.summary !== "stale result"));
    assert.equal(h.faux.state.callCount, 1);
  } finally { finish(); }
});

test("transport-neutral Bot IPC can use the Vivi facade through its narrow port", async t => {
  const h = await fixture(t);
  const host = h.host();
  h.faux.setResponses([h.report("IPC ready")]);
  host.start();
  registerBotIpc({ bot: host.api });
  const ctx = { kind: "window" as const, window: null };
  const accepted = await dispatch(Ipc.botSubmit, { requestId: "ipc", text: "do the IPC task" }, ctx) as WorkSnapshot;
  assert.equal(accepted.conversations.length, 1);
  await host.idle();
  const snapshot = await dispatch(Ipc.botGetWorkSnapshot, undefined, ctx) as WorkSnapshot;
  assert.equal(snapshot.conversations[0]?.conversationId, accepted.conversations[0]?.conversationId);
  assert.equal(snapshot.results[0]?.status, "ready");
  assert.equal(snapshot.results[0]?.summary, "IPC ready");
  assert.deepEqual(await dispatch(Ipc.botGetActivity, undefined, ctx), host.api.activity());
  const cleared = await dispatch(Ipc.botClearChat, undefined, ctx) as WorkSnapshot;
  assert.equal(cleared.chatGeneration, 1);
  const stopped = await dispatch(Ipc.botStopAll, undefined, ctx) as WorkSnapshot;
  assert.equal(stopped.conversations.length, 1);
  assert.equal(h.faux.state.callCount, 1);
});
