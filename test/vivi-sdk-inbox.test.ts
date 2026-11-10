import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ModelRuntime, type ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { createFauxCore, fauxAssistantMessage, fauxToolCall, InMemoryModelsStore } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { ScratchPiSession } from "../src/main/bot/shadow/pi-session.ts";
import { openShadowStore } from "../src/main/bot/shadow/store.ts";
import type { WorkerToken } from "../src/main/bot/shadow/engine.ts";

// Real SDK, isolated ModelRuntime, scripted offline provider; no external credentials or requests.
const binding: WorkerToken = { ticketId: "inbox-ticket", assignmentId: "inbox-assignment", generation: 1, claimToken: 1 };
type Options = Parameters<typeof ScratchPiSession.open>[0];
type Responses = Parameters<ReturnType<typeof createFauxCore>["setResponses"]>[0];
const timeout = { timeout: 15_000 };
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
async function until(check: () => boolean) {
  const deadline = Date.now() + 5_000;
  while (!check()) { if (Date.now() > deadline) throw new Error("SDK inbox boundary timeout"); await new Promise<void>(done => setImmediate(done)); }
}
async function harness(t: TestContext, responses: Responses = [fauxAssistantMessage("done")], overrides: Partial<Options> = {}, suppliedRoot?: string) {
  const root = suppliedRoot ?? mkdtempSync(join(tmpdir(), "vivi-sdk-inbox-"));
  const file = join(root, "shadow.db");
  let store = openShadowStore(file);
  const faux = createFauxCore({ api: "inbox-faux-api", provider: "inbox-faux", models: [{ id: "offline" }] });
  faux.setResponses(responses);
  const runtime = await ModelRuntime.create({ authPath: join(root, "auth.json"), modelsPath: null, modelsStore: new InMemoryModelsStore(), allowModelNetwork: false, refreshOnCreate: false });
  runtime.registerProvider("inbox-faux", { baseUrl: "http://faux.invalid", api: "inbox-faux-api" as never, apiKey: "unused", streamSimple: faux.streamSimple as never,
    models: [{ id: "offline", name: "offline", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100_000, maxTokens: 4096 }] });
  const sessions: ScratchPiSession[] = [];
  const open = async (extra: Partial<Options> = {}) => {
    const adapter = await ScratchPiSession.open({ store, root, binding, modelRuntime: runtime, model: runtime.getModel("inbox-faux", "offline")!, ...overrides, ...extra });
    sessions.push(adapter); return adapter;
  };
  t.after(async () => { for (const adapter of sessions.reverse()) await adapter.dispose(); store.close(); rmSync(root, { recursive: true, force: true }); });
  const adapter = await open();
  return { root, adapter, faux, runtime, open, get store() { return store; }, async restart() {
    await sessions.at(-1)!.dispose(); store.close(); store = openShadowStore(file); return open();
  } };
}
function entries(adapter: ScratchPiSession) { return readFileSync(adapter.session.sessionFile!, "utf8").trim().split("\n").map(line => JSON.parse(line)); }
function users(adapter: ScratchPiSession) { return entries(adapter).filter(row => row.type === "message" && row.message.role === "user"); }
const input = { requestId: "prepared", text: "DURABLE_INBOX_INPUT", inputIds: ["input-1"] };

test("prepare only accepts durably: no SDK input hook, provider request, user JSONL or persisted callback", timeout, async t => {
  let hooks = 0, persisted = 0;
  const h = await harness(t, undefined, { extensions: [pi => { pi.on("input", () => { hooks++; }); }], onPersisted: () => { persisted++; } });
  const history = readFileSync(h.adapter.session.sessionFile!, "utf8");
  const receipt = h.adapter.prepare(input);
  assert.equal(receipt.stage, "accepted"); assert.equal(receipt.status, "accepted"); assert.equal(receipt.entryId, undefined);
  assert.deepEqual(receipt.binding, binding); assert.deepEqual(receipt.reads, []);
  assert.deepEqual(h.store.sessionReceipts.get(h.adapter.sessionKey, input.requestId), receipt);
  assert.deepEqual(h.adapter.prepare(input), receipt);
  assert.throws(() => h.adapter.prepare({ ...input, text: "different" }));
  await new Promise<void>(done => setImmediate(done));
  assert.equal(hooks, 0); assert.equal(persisted, 0); assert.equal(h.faux.state.callCount, 0);
  assert.equal(readFileSync(h.adapter.session.sessionFile!, "utf8"), history); assert.deepEqual(users(h.adapter), []);
});

test("fast provider cannot run before external delivered guard permits activation", timeout, async t => {
  let delivered = false;
  const h = await harness(t, undefined, { validate: () => { if (!delivered) throw new Error("delivery not committed"); } });
  // Host accepts inbox and delivery projection in one synchronous transaction, then dispatches.
  delivered = true; h.adapter.prepare(input); delivered = false;
  await assert.rejects(h.adapter.activate(input.requestId), /delivery not committed/);
  assert.equal(h.faux.state.callCount, 0); assert.deepEqual(users(h.adapter), []);
  delivered = true;
  await (await h.adapter.activate(input.requestId)).completion;
  assert.equal(h.faux.state.callCount, 1); assert.equal(users(h.adapter).length, 1);
});

test("concurrent activate shares completion and dispatches one actual SDK input/provider request", timeout, async t => {
  const gate = deferred(); t.after(gate.resolve);
  const h = await harness(t, [async () => { await gate.promise; return fauxAssistantMessage("done"); }]);
  h.adapter.prepare(input);
  const results = await Promise.all(Array.from({ length: 8 }, () => h.adapter.activate(input.requestId)));
  await until(() => h.faux.state.callCount === 1);
  assert.equal(results.filter(result => !result.reused).length, 1);
  for (const result of results) assert.equal(result.completion, results[0]!.completion);
  assert.equal(users(h.adapter).length, 1);
  gate.resolve(); await Promise.all(results.map(result => result.completion));
  const receipt = h.adapter.get(input.requestId)!;
  assert.ok(receipt.entryId); assert.equal(receipt.reads.length, 1);
  assert.equal((await h.adapter.activate(input.requestId)).reused, true);
  assert.equal(h.faux.state.callCount, 1); assert.equal(users(h.adapter).length, 1);
});

test("persisted but unread input never dispatches a second time through activate", timeout, async t => {
  const extension: ExtensionFactory = pi => { pi.on("context", event => ({ messages: event.messages.filter(message => message.role !== "user") })); };
  const h = await harness(t, undefined, { extensions: [extension] });
  h.adapter.prepare(input); await (await h.adapter.activate(input.requestId)).completion;
  assert.equal(h.adapter.get(input.requestId)!.stage, "persisted"); assert.deepEqual(h.adapter.get(input.requestId)!.reads, []);
  await (await h.adapter.activate(input.requestId)).completion;
  assert.equal(h.faux.state.callCount, 1); assert.equal(users(h.adapter).length, 1);
});

test("handled terminal input cannot be reactivated", timeout, async t => {
  const h = await harness(t, undefined, { extensions: [pi => { pi.on("input", () => ({ action: "handled" })); }] });
  h.adapter.prepare(input); await (await h.adapter.activate(input.requestId)).completion;
  assert.equal(h.adapter.get(input.requestId)!.status, "handled");
  await (await h.adapter.activate(input.requestId)).completion;
  assert.equal(h.faux.state.callCount, 0); assert.deepEqual(users(h.adapter), []);
});

test("Stop followed by activate never resumes session or dispatches stopped inbox, including after explicit resume", timeout, async t => {
  const h = await harness(t); h.adapter.prepare(input); await h.adapter.stop();
  await assert.rejects(h.adapter.activate(input.requestId));
  assert.equal(h.adapter.ledger.session(h.adapter.sessionKey)!.paused, true);
  assert.equal(h.adapter.get(input.requestId)!.status, "stopped");
  await h.adapter.resume(); await (await h.adapter.activate(input.requestId)).completion;
  assert.equal(h.faux.state.callCount, 0); assert.deepEqual(users(h.adapter), []);
});

test("rebind refuses activation of prepared input owned by previous binding", timeout, async t => {
  const h = await harness(t); h.adapter.prepare(input);
  await h.adapter.rebind({ ...binding, assignmentId: "new-assignment", generation: 2, claimToken: 2 });
  await assert.rejects(h.adapter.activate(input.requestId), /another binding/);
  assert.equal(h.faux.state.callCount, 0); assert.deepEqual(users(h.adapter), []);
});

test("rebind refuses prepare replay of previous binding instead of returning its stale accepted receipt", timeout, async t => {
  const h = await harness(t); const old = h.adapter.prepare(input);
  await h.adapter.rebind({ ...binding, assignmentId: "new-assignment", generation: 2, claimToken: 2 });
  assert.throws(() => h.adapter.prepare(input), /binding|superseded/i);
  assert.deepEqual(h.adapter.get(input.requestId)!.binding, old.binding);
  assert.equal(h.faux.state.callCount, 0);
});

test("same binding dispose/store reopen preserves prepared inbox and emits persisted exactly once on explicit activation", timeout, async t => {
  const persisted: string[][] = [];
  const h = await harness(t, undefined, { onPersisted: (_token, ids) => { persisted.push(ids); } });
  const prepared = h.adapter.prepare(input), file = h.adapter.session.sessionFile;
  const reopened = await h.restart();
  assert.equal(reopened.session.sessionFile, file); assert.deepEqual(reopened.get(input.requestId)!.binding, prepared.binding);
  assert.equal(h.faux.state.callCount, 0); assert.deepEqual(users(reopened), []); assert.deepEqual(persisted, []);
  await (await reopened.activate(input.requestId)).completion;
  const id = reopened.get(input.requestId)!.entryId; assert.ok(id);
  await (await reopened.activate(input.requestId)).completion;
  const again = await h.restart(); await (await again.activate(input.requestId)).completion;
  assert.equal(again.get(input.requestId)!.entryId, id); assert.equal(users(again).length, 1);
  assert.equal(h.faux.state.callCount, 1); assert.deepEqual(persisted, [["input-1"]]);
});

for (const role of ["reviewer", "coordinator"] as const) test(`${role} has isolated transcript, exact registered custom tools and retains toolset after reload`, timeout, async t => {
  const declared: string[][] = []; let toolCalls = 0;
  const custom: ExtensionFactory = pi => {
    pi.registerTool({ name: "read_file", label: "Read fixture", description: "Read fixed offline test content", parameters: Type.Object({}),
      async execute() { toolCalls++; return { content: [{ type: "text", text: "FIXED_READONLY_CONTENT" }], details: {} }; } });
    pi.registerTool({ name: "extra_tool", label: "Excluded", description: "Must stay inactive", parameters: Type.Object({}),
      async execute() { throw new Error("Inactive custom tool was executed"); } });
  };
  const respond: Responses[number] = context => {
    const tools = new Map<string, unknown>();
    for (const message of context.messages) if (message.role === "system") {
      for (const tool of message.toolsRemoved ?? []) tools.delete(tool.name);
      for (const tool of message.toolsAdded ?? []) tools.set(tool.name, tool);
    }
    declared.push([...tools.keys()].sort());
    assert.doesNotMatch(JSON.stringify(context.messages), /WORKER_ONLY_/);
    return fauxAssistantMessage([fauxToolCall("read_file", {})], { stopReason: "toolUse" });
  };
  const h = await harness(t, [fauxAssistantMessage("WORKER_ONLY_HISTORY"), respond, fauxAssistantMessage("role finished"), respond, fauxAssistantMessage("role after reload")]);
  await (await h.adapter.submit({ requestId: "worker", text: "WORKER_ONLY_INPUT" })).completion;
  const workerHistory = readFileSync(h.adapter.session.sessionFile!, "utf8");
  const isolated = await h.open({ sessionKey: `${role}-fixed-artifact`, activeTools: ["read_file"], extensions: [custom] });
  assert.notEqual(isolated.session.sessionFile, h.adapter.session.sessionFile);
  assert.deepEqual(isolated.session.getActiveToolNames(), ["read_file"]);
  isolated.prepare(input); await (await isolated.activate(input.requestId)).completion;
  await isolated.reload(); assert.deepEqual(isolated.session.getActiveToolNames(), ["read_file"]);
  isolated.prepare({ ...input, requestId: "after-reload" }); await (await isolated.activate("after-reload")).completion;
  assert.equal(toolCalls, 2); assert.deepEqual(declared, [["read_file"], ["read_file"]]);
  const roleHistory = readFileSync(isolated.session.sessionFile!, "utf8");
  assert.match(roleHistory, /FIXED_READONLY_CONTENT/); assert.doesNotMatch(roleHistory, /WORKER_ONLY_|vivi_report/);
  assert.equal(readFileSync(h.adapter.session.sessionFile!, "utf8"), workerHistory);
  assert.equal(h.adapter.get(input.requestId), undefined);
});

for (const sessionKey of ["reviewer-../escape", "reviewer-", "coordinator-a/b", "worker-other-ticket", "arbitrary-role", "reviewer-a%2fb"]) test(`invalid role sessionKey rejected: ${sessionKey}`, timeout, async t => {
  const h = await harness(t);
  await assert.rejects(h.open({ sessionKey, activeTools: [] }), /role Session key/);
  assert.equal(h.faux.state.callCount, 0);
});

test("host validation fences dispatch after an asynchronous SDK preflight", timeout, async t => {
  const gate = deferred(); t.after(gate.resolve); let current = true, entered = false;
  const h = await harness(t, undefined, { validate: () => { if (!current) throw new Error("HOST_FENCE"); }, extensions: [pi => {
    pi.on("before_agent_start", async () => { entered = true; await gate.promise; });
  }] });
  h.adapter.prepare(input); const activation = h.adapter.activate(input.requestId);
  // Attach rejection handling before releasing the deliberately rejected SDK path.
  const outcome = activation.then(async result => { await result.completion.catch(() => {}); }, () => {});
  await until(() => entered); current = false; gate.resolve(); await outcome;
  assert.equal(h.faux.state.callCount, 0); assert.deepEqual(h.adapter.get(input.requestId)!.reads, []);
});

test("host validation rejects late onRead callback after provider stream boundary", timeout, async t => {
  let current = true, reads = 0, refused = 0;
  const h = await harness(t, undefined, { validate: () => { if (!current) { refused++; throw new Error("HOST_FENCE"); } }, onRead: () => { reads++; } });
  const runtimeStream = h.runtime.streamSimple.bind(h.runtime);
  // Revoke after the real ModelRuntime stream boundary, before onRead runs.
  h.runtime.streamSimple = ((...args: Parameters<typeof runtimeStream>) => { const result = runtimeStream(...args); current = false; return result; }) as typeof h.runtime.streamSimple;
  h.adapter.prepare(input);
  const result = await h.adapter.activate(input.requestId); await result.completion.catch(() => {});
  assert.equal(reads, 0); assert.ok(refused > 0, "late callback must actually reach the rejecting host fence");
  assert.equal(h.faux.state.callCount, 1);
});

test("host validation rejects late vivi_report before domain callback and report journal commit", timeout, async t => {
  const gate = deferred(); t.after(gate.resolve); let current = true, reports = 0;
  const h = await harness(t, [async () => { await gate.promise; return fauxAssistantMessage([fauxToolCall("vivi_report", { state: "ready", summary: "late" })], { stopReason: "toolUse" }); }, fauxAssistantMessage("done")], {
    validate: () => { if (!current) throw new Error("HOST_FENCE"); }, onReport: () => { reports++; return true; },
  });
  h.adapter.prepare(input); const result = await h.adapter.activate(input.requestId);
  await until(() => h.adapter.get(input.requestId)!.reads.length === 1);
  current = false; gate.resolve(); await result.completion.catch(() => {});
  assert.equal(reports, 0); assert.deepEqual(h.adapter.get(input.requestId)!.reports, []);
  assert.equal(entries(h.adapter).some(row => row.customType === "fastvibe-vivi-report"), false);
  assert.equal(h.faux.state.callCount, 1);
});

test("real child exits immediately after prepare without SDK dispatch; reopened same binding activates exactly once", timeout, async t => {
  const root = mkdtempSync(join(tmpdir(), "vivi-sdk-inbox-crash-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const fixture = fileURLToPath(new URL("./fixtures/vivi-sdk-inbox-crash.ts", import.meta.url));
  const child = spawn(process.execPath, [fixture, root], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); });
  let output = "";
  child.stdout.on("data", chunk => { output += chunk; }); child.stderr.on("data", chunk => { output += chunk; });
  const exit = await new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("exit", resolve); });
  assert.equal(exit, 76, output);
  const persisted: string[][] = [];
  const h = await harness(t, undefined, { onPersisted: (_token, ids) => { persisted.push(ids); } }, root);
  const before = h.adapter.get(input.requestId)!;
  assert.equal(before.stage, "accepted"); assert.equal(before.status, "accepted"); assert.equal(before.entryId, undefined);
  assert.deepEqual(users(h.adapter), []); assert.equal(h.faux.state.callCount, 0);
  const [one, two] = await Promise.all([h.adapter.activate(input.requestId), h.adapter.activate(input.requestId)]);
  await Promise.all([one.completion, two.completion]);
  await (await h.adapter.activate(input.requestId)).completion;
  assert.equal(h.faux.state.callCount, 1); assert.equal(users(h.adapter).length, 1);
  assert.deepEqual(persisted, [["input-1"]]); assert.ok(h.adapter.get(input.requestId)!.entryId);
});

for (const refusal of ["false", "async"] as const) test(`READ acceptance ${refusal} rolls back domain/Pi facts and never leaves a replayable mirror`, timeout, async t => {
  const h = await harness(t, undefined, { onRead: () => {
    h.store.set("test:read-side-effect", true);
    return refusal === "false" ? false : Promise.resolve() as never;
  } });
  h.adapter.prepare(input);
  const result = await h.adapter.activate(input.requestId); await result.completion.catch(() => {});
  assert.equal(h.faux.state.callCount, 1);
  assert.equal(h.store.get("test:read-side-effect"), undefined);
  assert.deepEqual(h.adapter.get(input.requestId)!.reads, []);
  assert.equal(entries(h.adapter).some(row => row.customType === "fastvibe-vivi-read"), false);
  const reopened = await h.restart();
  assert.deepEqual(reopened.get(input.requestId)!.reads, []);
  assert.equal(h.faux.state.callCount, 1);
});

test("an uncommitted legacy READ mirror cannot create input-read or report authority during reconciliation", timeout, async t => {
  const h = await harness(t);
  h.adapter.session.agent.streamFunction = () => { throw new Error("No provider stream"); };
  h.adapter.prepare(input); const result = await h.adapter.activate(input.requestId); await result.completion.catch(() => {});
  assert.ok(h.adapter.get(input.requestId)!.entryId); assert.deepEqual(h.adapter.get(input.requestId)!.reads, []);
  h.adapter.session.sessionManager.appendCustomEntry("fastvibe-vivi-read", { sessionKey: h.adapter.sessionKey, epoch: h.adapter.ledger.session(h.adapter.sessionKey)!.epoch, binding, turnId: "uncommitted-legacy-read", requestIds: [input.requestId], at: Date.now() });
  await h.adapter.activate(input.requestId);
  assert.deepEqual(h.adapter.get(input.requestId)!.reads, []);
  assert.equal(h.adapter.report({ state: "ready", summary: "forged mirror" }), false);
});
