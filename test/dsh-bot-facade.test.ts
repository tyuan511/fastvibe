import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createFauxCore, fauxAssistantMessage, fauxToolCall, InMemoryModelsStore } from "@earendil-works/pi-ai";
import { DshBotFacade } from "../src/main/bot/shadow/dsh-bot-facade.ts";
import { key as domainKey } from "../src/main/bot/core/ids.ts";
import { effectRequestId } from "../src/main/bot/shadow/effects.ts";
import { openShadowStore } from "../src/main/bot/shadow/store.ts";
import { ViviDshRuntime } from "../src/main/bot/shadow/vivi-dsh-runtime.ts";

// Same offline ModelRuntime/createFauxCore fixture as vivi-dsh-runtime.test.ts.
async function harness(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), "dsh-facade-"));
  const file = join(root, "shadow.db");
  const store = openShadowStore(file);
  const faux = createFauxCore({ api: "dshapi", provider: "vivi-dsh", models: [{ id: "offline" }] });
  const modelRuntime = await ModelRuntime.create({ authPath: join(root, "auth.json"), modelsPath: null,
    modelsStore: new InMemoryModelsStore(), allowModelNetwork: false, refreshOnCreate: false });
  modelRuntime.registerProvider("vivi-dsh", { baseUrl: "http://offline.invalid", api: "dshapi" as never, apiKey: "offline", streamSimple: faux.streamSimple as never,
    models: [{ id: "offline", name: "offline", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100_000, maxTokens: 4096 }] });
  let facade!: DshBotFacade;
  const runtime = new ViviDshRuntime({ store, root: join(root, "workers"), modelRuntime, model: modelRuntime.getModel("vivi-dsh", "offline")!,
    maxWorkers: () => 1, onEvent: () => facade?.notifyDomainEvent() });
  facade = new DshBotFacade(store, runtime);
  t.after(async () => { await runtime.stop(); store.close(); rmSync(root, { recursive: true, force: true }); });
  return { root, file, store, faux, runtime, facade };
}
const ready = () => fauxAssistantMessage([fauxToolCall("dsh_report", { state: "ready", summary: "real SDK ready" })], { stopReason: "toolUse" });
async function until(check: () => boolean) {
  const deadline = Date.now() + 8_000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("SDK did not progress");
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}
function rows(store: ReturnType<typeof openShadowStore>) {
  return Object.fromEntries(store.db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'dsh_%' ORDER BY name")
    .map(({ name }) => [name, store.db.all(`SELECT * FROM "${name}" ORDER BY rowid`)]));
}

test("未 attach 的无模型首启可读取 store，stop 安全且读取不写投影", async t => {
  const store = openShadowStore(":memory:");
  t.after(() => store.close());
  const facade = new DshBotFacade(store);
  const before = rows(store);
  await facade.stop();
  assert.equal((await facade.getWorkSnapshot()).conversations.length, 0);
  assert.deepEqual(await facade.getActivity(), { running: false, waiting: false });
  assert.deepEqual(rows(store), before);
  assert.throws(() => facade.start(), /attach/);
  await assert.rejects(facade.submit({ requestId: "no-model", text: "work" }), /attach/);
  assert.deepEqual(rows(store), before);
});

test("真实 SDK assignment activity、ready/result、stop/retry 及重开 revision", { timeout: 15_000 }, async t => {
  const h = await harness(t);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  h.faux.setResponses([async () => { await gate; return ready(); }]);
  const submitted = await h.facade.submit({ requestId: "sdk", text: "work" });
  const id = submitted.conversations[0]!.conversationId;
  assert.equal(submitted.results.length, 0);
  assert.equal(submitted.progress?.[0]?.phase, "accepted");
  assert.equal(h.facade.activity().running, true);
  h.runtime.start();
  try {
    await until(() => h.faux.state.callCount === 1);
    assert.equal(h.runtime.ticket(id)?.assignments.at(-1)?.state, "running");
    assert.equal((await h.facade.getWorkSnapshot()).progress?.[0]?.phase, "working");
    const stopped = await h.facade.stopConversation({ conversationId: id });
    assert.equal(stopped.progress?.[0]?.phase, "paused");
    assert.equal(h.facade.activity().running, false);
  } finally { release(); }
  await h.runtime.idle();
  assert.notEqual((await h.facade.getWorkSnapshot()).results[0]?.status, "ready");
  await assert.rejects(h.facade.continueConversation({ conversationId: id }), /Only an open ticket/);
  h.faux.setResponses([fauxAssistantMessage([fauxToolCall("dsh_report", { state: "failed", summary: "retryable failure" })], { stopReason: "toolUse" })]);
  const failedSubmission = await h.facade.submit({ requestId: "retry", text: "retryable work" });
  const retryId = failedSubmission.conversations.find(item => item.conversationId !== id)!.conversationId;
  await h.runtime.idle();
  assert.equal((await h.facade.getWorkSnapshot()).results.find(item => item.conversationId === retryId)?.status, "failed");
  h.faux.setResponses([ready()]);
  const retried = await h.facade.continueConversation({ conversationId: retryId });
  assert.equal(retried.results.some(item => item.conversationId === retryId), false);
  assert.equal(retried.progress?.find(item => item.conversationId === retryId)?.phase, "accepted");
  await h.runtime.idle();
  const completed = await h.facade.getWorkSnapshot();
  assert.equal(h.runtime.ticket(retryId)?.assignments.length, 2);
  assert.equal(h.runtime.ticket(retryId)?.assignments.at(-1)?.report?.state, "ready");
  assert.equal(completed.results.find(item => item.conversationId === retryId)?.status, "ready");
  assert.equal(completed.results.find(item => item.conversationId === retryId)?.summary, "real SDK ready");
  assert.equal(completed.progress?.find(item => item.conversationId === retryId)?.phase, "completed");
  assert.equal(h.facade.activity().running, false);
  await assert.rejects(h.facade.report({ conversationId: id, summary: "forged", outcome: "ready" }), /SDK/);
  await h.runtime.stop();
  const reopened = openShadowStore(h.file);
  try {
    const read = await new DshBotFacade(reopened).getWorkSnapshot();
    assert.equal(read.revision, completed.revision);
    assert.deepEqual(read.results, completed.results);
    assert.deepEqual(read.messages, completed.messages);
  } finally { reopened.close(); }
});

test("unsupported 输入与旧扩展入口拒绝且零写入；SQL ABORT 回滚整个接受事务", async t => {
  const h = await harness(t);
  const before = rows(h.store);
  for (const extra of [{ images: [{ data: "x", mimeType: "image/png" }] }, { conversationId: "dsh-router" }, { memoryRefs: [{ path: "MEMORY.md" }] }, { behavior: "steer" }, { project: "/tmp" }, { workspace: "vivi" }]) {
    await assert.rejects(h.facade.submit({ requestId: "unsupported", text: "work", ...extra }), /不支持/);
  }
  for (const extra of [{ project: "/tmp" }, { workspace: "vivi" as const }, { memoryRefs: [{ path: "MEMORY.md" }] }]) {
    await assert.rejects(h.facade.createWork({ requestId: "unsupported", title: "work", text: "work", ...extra }), /不支持/);
  }
  await assert.rejects(h.facade.ask({ conversationId: "x", question: "?" }), /主 Session/);
  // `answer` now routes through the domain reply path: an unknown attention id is refused by the
  // durable Ticket lookup, not by a missing main-Session port.
  await assert.rejects(h.facade.answer({ attentionId: "x", answer: "yes" }), /attention 不存在或已被替换/);
  await assert.rejects(h.facade.progress({ conversationId: "x", phase: "working", text: "fake" }), /binding\/epoch/);
  await assert.rejects(h.facade.reply({ conversationId: "x", text: "fake" }), /binding\/epoch/);
  await assert.rejects(h.facade.report({ conversationId: "x", summary: "fake" }), /SDK/);
  assert.deepEqual(rows(h.store), before);
  h.store.db.exec("CREATE TRIGGER abort_projection BEFORE INSERT ON dsh_kv WHEN NEW.key='dsh:bot:projection:v1' BEGIN SELECT RAISE(ABORT, 'projection aborted'); END");
  await assert.rejects(h.facade.submit({ requestId: "rollback", text: "work" }), /projection aborted/);
  assert.deepEqual(rows(h.store), before);
  h.store.db.exec("DROP TRIGGER abort_projection");
  const accepted = await h.facade.submit({ requestId: "rollback", text: "work" });
  assert.equal(accepted.conversations.length, 1);
  assert.equal(accepted.messages.length, 1);
});

test("重复请求无 revision 变化，clearChat 后不复活；旧 bot 表原行完全不变", async t => {
  const h = await harness(t);
  const legacyTables = h.store.db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'bot_%' ORDER BY name").map(row => row.name);
  h.store.db.exec(`
    INSERT INTO bot_meta VALUES('sentinel','unchanged');
    INSERT INTO bot_conversations VALUES('legacy','worker','vivi','legacy',0,0,1,1,'{}');
    INSERT INTO bot_v2_inputs VALUES('legacy-input','legacy',0,'user','keep','completed',1,'{}');
    INSERT INTO bot_attention VALUES('legacy-attention','legacy',NULL,0,'pending',1,'{}');
    INSERT INTO bot_results VALUES('legacy-result','legacy',NULL,0,'ready',1,'{}');
    INSERT INTO bot_outbox VALUES('legacy-delivery','legacy','legacy','delivered',1,'{}');
    INSERT INTO bot_chat_messages VALUES('legacy-message','legacy','user',NULL,1,'{}');
  `);
  const legacy = () => legacyTables.map(name => h.store.db.all(`SELECT * FROM ${name} ORDER BY rowid`));
  const original = legacy();
  const request = { requestId: "same", text: "work", behavior: "followUp" };
  const first = await h.facade.submit(request);
  assert.deepEqual(await h.facade.submit(request), first);
  const cleared = await h.facade.clearChat();
  assert.equal(cleared.messages.length, 0);
  assert.equal(cleared.chatGeneration, 1);
  assert.deepEqual(await h.facade.submit(request), cleared);
  await assert.rejects(h.facade.submit({ ...request, text: "drift" }), /payload/);
  assert.deepEqual(await h.facade.getWorkSnapshot(), cleared);
  const work = { requestId: "create", text: "create", title: "Create" };
  await h.facade.createWork(work);
  const created = await h.facade.getWorkSnapshot();
  await h.facade.createWork(work);
  assert.deepEqual(await h.facade.getWorkSnapshot(), created);
  await h.facade.stopAll();
  assert.equal(h.facade.activity().running, false);
  assert.deepEqual(legacy(), original);
  assert.equal(h.store.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM dsh_kv WHERE key LIKE 'bot:%'")?.n, 0);
});

test("真实 SDK waiting/attention 时间稳定，旧 projection.progress 不影响 activity", async t => {
  const h = await harness(t);
  h.faux.setResponses([fauxAssistantMessage([fauxToolCall("dsh_report", { state: "waiting", summary: "waiting for input", question: "Which file?" })], { stopReason: "toolUse" })]);
  await h.facade.submit({ requestId: "waiting", text: "wait" });
  h.runtime.start(); await h.runtime.idle();
  const first = await h.facade.getWorkSnapshot();
  assert.equal(first.results[0]?.status, "uncertain");
  assert.equal(first.progress?.[0]?.phase, "waiting");
  assert.equal(first.attention.length, 1);
  assert.ok(first.attention[0]!.createdAt > 0);
  const state = h.store.get<Record<string, unknown>>("dsh:bot:projection:v1")!;
  h.store.set("dsh:bot:projection:v1", { ...state, progress: [{ phase: "working", conversationId: "fake" }] });
  assert.deepEqual(h.facade.activity(), { running: false, waiting: true });
  const later = new DshBotFacade(h.store, undefined, { now: () => Date.now() + 100_000 });
  assert.deepEqual((await later.getWorkSnapshot()).attention, first.attention);
  assert.equal((await later.getWorkSnapshot()).revision, first.revision);
});

test("真实 relay effect 身份、持久幂等、clear 后不复活；completion 仅 ready 且已投递时发一次", async t => {
  const h = await harness(t);
  h.faux.setResponses([ready()]);
  const submitted = await h.facade.submit({ requestId: "relay", text: "work" });
  const ticketId = submitted.conversations[0]!.conversationId;
  h.runtime.start(); await h.runtime.idle(); await h.runtime.stop();
  const events: import("../src/shared/bot.ts").BotChanged[] = [];
  h.facade.onChanged(event => events.push(event));
  h.store.receipts.add({ id: "delivery", ticketId, text: "Delivered result", kind: "reply", channel: { source: "local", thread: "local", address: {} } });
  const payload = { text: "Delivered result" };
  const now = Date.now();
  h.store.effects.enqueue("relay", "relay-key", payload, now);
  const claim = h.store.effects.claim("relay", "relay-key", "host", now, 60_000)!;
  const context = { claim, signal: new AbortController().signal, requestId: effectRequestId(claim) };
  await assert.rejects(h.facade.receiveRelay(payload, { ...context, requestId: "forged" }), /身份/);
  await assert.rejects(h.facade.receiveRelay({ ...payload, text: "forged" }, context), /身份/);
  await h.facade.receiveRelay(payload, context);
  assert.equal((await h.facade.getWorkSnapshot()).messages.at(-1)?.text, payload.text);
  assert.equal(events.filter(event => event.completion).length, 0);
  const cleared = await h.facade.clearChat();
  assert.equal(await h.facade.receiveRelay(payload, context), undefined);
  assert.deepEqual(await h.facade.getWorkSnapshot(), cleared);
  h.store.receipts.settle("delivery", "sent");
  const ticket = h.runtime.ticket(ticketId)!;
  const deliveredPayload = { text: JSON.stringify({ kind: "worker_report", ticket: { id: ticketId }, state: "ready", summary: "real SDK ready", trigger_id: ticket.origin.triggerId }) };
  const report = ticket.assignments.at(-1)!.report!;
  const reportKey = `report:${domainKey("worker-result", ticketId, report.at, report.summary)}`;
  h.store.effects.enqueue("relay", reportKey, deliveredPayload, now);
  const delivered = h.store.effects.claim("relay", reportKey, "host", now, 60_000)!;
  const deliveredContext = { ...context, claim: delivered, requestId: effectRequestId(delivered) };
  await h.facade.receiveRelay(deliveredPayload, deliveredContext);
  await h.facade.receiveRelay(deliveredPayload, deliveredContext);
  const snapshot = await h.facade.getWorkSnapshot();
  assert.equal(snapshot.deliveries.find(item => item.id === "delivery")?.createdAt, Date.parse(h.runtime.ticket(ticketId)!.createdAt));
  await h.facade.getWorkSnapshot();
  assert.equal(events.filter(event => event.completion).length, 1);
  assert.equal(events.find(event => event.completion)?.completion?.conversationId, ticketId);
  const read = new DshBotFacade(h.store, undefined, { now: () => now + 20_000 });
  assert.deepEqual((await read.getWorkSnapshot()).deliveries, snapshot.deliveries);
});
