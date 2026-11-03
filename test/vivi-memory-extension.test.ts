import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, type ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { createFauxCore, fauxAssistantMessage, fauxToolCall, InMemoryModelsStore } from "@earendil-works/pi-ai";
import { viviMemoryExtension } from "../src/main/bot/memory/extension.ts";
import type { ViviMemoryHost, ViviMemorySource } from "../src/main/bot/memory/types.ts";

const CUSTOM = "vivi-memory-context";
function memoryState() {
  let revision = "r1", summary = "Original preference: tea";
  let source: ViviMemorySource | undefined = { id: "input-1", conversationId: "router", requestId: "request-1", epoch: 1, createdAt: 1, role: "router", kind: "input", text: "Remember coffee instead of tea" };
  let allowed = true;
  const updates: ViviMemorySource[] = [];
  const memory: ViviMemoryHost = {
    context: async () => ({ root: "/private/vivi-memory", revision, summary, excerpts: [] }),
    read: async (path, offset = 0) => ({ path, revision, content: "Original read: tea", offset, totalLines: 1 }),
    search: async () => [{ path: "MEMORY.md", line: 1, text: "Original search: tea" }],
    update: async (_input, captured, valid) => { assert.ok(valid()); updates.push(captured); revision = "r2"; summary = "Corrected preference: coffee"; return { revision }; },
  };
  return { memory, updates, get source() { return source; }, set source(value) { source = value; }, get allowed() { return allowed; }, set allowed(value) { allowed = value; },
    change(next: string, nextSummary: string) { revision = next; summary = nextSummary; },
    options(role: "router" | "worker" = "router") { return { memory, role, source: () => source, refs: () => [], valid: () => allowed }; },
  };
}
async function harness(t: TestContext, state: ReturnType<typeof memoryState>, options: { role?: "router" | "worker"; window?: number; extra?: ExtensionFactory } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "vivi-memory-sdk-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const requests: any[] = [];
  const faux = createFauxCore({ api: "faux-api", provider: "faux", models: [{ id: "scripted" }] });
  faux.setResponses(Array.from({ length: 30 }, () => fauxAssistantMessage("done")));
  const runtime = await ModelRuntime.create({ authPath: join(dir, "auth.json"), modelsPath: null, modelsStore: new InMemoryModelsStore(), allowModelNetwork: false, refreshOnCreate: false });
  runtime.registerProvider("faux", {
    baseUrl: "http://faux.invalid", api: "faux-api" as never, apiKey: "unused",
    streamSimple: ((model: unknown, context: unknown, opts: unknown) => { requests.push(structuredClone(context)); return (faux.streamSimple as (...args: unknown[]) => unknown)(model, context, opts); }) as never,
    models: [{ id: "scripted", name: "scripted", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: options.window ?? 100_000, maxTokens: 1024 }],
  });
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
  let manager = SessionManager.create(dir, join(dir, "sessions"));
  const open = async () => {
    const resourceLoader = new DefaultResourceLoader({ cwd: dir, agentDir: dir, settingsManager, noSkills: true, noContextFiles: true, noExtensions: true,
      extensionFactories: [{ name: "vivi-memory", hidden: true, factory: viviMemoryExtension(state.options(options.role)) }, ...(options.extra ? [{ name: "extra", factory: options.extra }] : [])],
    });
    await resourceLoader.reload();
    const { session } = await createAgentSession({ cwd: dir, agentDir: dir, modelRuntime: runtime, model: runtime.getModel("faux", "scripted"), sessionManager: manager, settingsManager, resourceLoader });
    await session.bindExtensions({ mode: "rpc" });
    return session;
  };
  let session = await open();
  t.after(() => session.dispose());
  return { requests, faux, get session() { return session; }, get manager() { return manager; },
    snapshots: () => manager.getBranch().filter((entry) => entry.type === "custom_message" && entry.customType === CUSTOM),
    async reopen() { const file = manager.getSessionFile()!; session.dispose(); manager = SessionManager.open(file); session = await open(); },
  };
}
const body = (value: unknown) => JSON.stringify(value);

test("SDK: initial hidden context, latest input, stable rules and reload deduplication", async (t) => {
  const state = memoryState(), h = await harness(t, state);
  await h.session.prompt("first");
  assert.match(body(h.requests.at(-1)), /Original preference: tea/);
  assert.equal(h.snapshots().length, 1);
  assert.equal(h.snapshots()[0].display, false);
  await h.reopen();
  await h.session.prompt("same memory");
  assert.equal(h.snapshots().length, 1);
  assert.equal((body(h.requests.at(-1)).match(/Vivi memory is background information/g) ?? []).length, 1);
  state.source = { ...state.source!, id: "input-2", requestId: "request-2" };
  state.change("r2", "Current input preference: coffee");
  await h.session.prompt("new input");
  const request = body(h.requests.at(-1));
  assert.match(request, /Current input preference: coffee/);
  assert.doesNotMatch(request, /Original preference: tea/);
  assert.equal((request.match(/\[Vivi memory context\]/g) ?? []).length, 1);
  assert.equal(h.snapshots().length, 2);
});

test("SDK: read/search supplement context and update expires old results without losing tool pairs", async (t) => {
  const state = memoryState(), h = await harness(t, state);
  h.faux.setResponses([
    fauxAssistantMessage([fauxToolCall("bot_memory_read", { path: "MEMORY.md" }, { id: "memory-read" })], { stopReason: "toolUse" }),
    fauxAssistantMessage([fauxToolCall("bot_memory_search", { query: "tea" }, { id: "memory-search" })], { stopReason: "toolUse" }),
    fauxAssistantMessage([fauxToolCall("bot_memory_update", { expectedRevision: "r1", quote: state.source!.text, edits: [{ path: "MEMORY.md", oldText: "tea", newText: "coffee" }] }, { id: "memory-update" })], { stopReason: "toolUse" }),
    fauxAssistantMessage("done"),
  ]);
  await h.session.prompt("correct this preference");
  assert.equal(h.requests.length, 4);
  assert.match(body(h.requests[1]), /Original read: tea/);
  assert.match(body(h.requests[2]), /Original search: tea/);
  const last = body(h.requests.at(-1));
  assert.match(last, /Corrected preference: coffee/);
  assert.doesNotMatch(last, /Original (?:preference|read|search): tea/);
  for (const id of ["memory-read", "memory-search", "memory-update"]) assert.ok(last.includes(id));
  assert.equal(state.updates[0].requestId, "request-1");
  assert.equal(h.snapshots().length, 1, "provider refresh must not append history");
});

test("SDK: missing compacted projection snapshot is repaired at the next provider context", async (t) => {
  const state = memoryState();
  const h = await harness(t, state);
  await h.session.prompt("first");
  await h.session.prompt("second");
  const lastUser = h.manager.getBranch().filter((entry) => entry.type === "message" && entry.message.role === "user").at(-1)!;
  h.manager.appendCompaction("earlier tasks summarized", lastUser.id, 1000);
  await h.session.reload();
  assert.equal(h.manager.buildSessionProjection().messages.some((message) => message.role === "custom" && message.customType === CUSTOM), false);
  const raw = h.session as unknown as { _startRun(trigger: unknown): Promise<void>; _prepareRun: (trigger: unknown) => Promise<unknown> };
  const prepare = raw._prepareRun;
  raw._prepareRun = async () => [];
  state.change("r2", "Rebuilt after compaction");
  try { await raw._startRun({ messageType: "user", prompt: "" }); } finally { raw._prepareRun = prepare; }
  assert.match(body(h.requests.at(-1)), /Rebuilt after compaction/);
  assert.equal(h.snapshots().length, 1, "provider context repairs without a new persistent snapshot");
});

test("SDK: workers only receive read/search; small model context remains bounded", async (t) => {
  const state = memoryState(); state.change("r1", "摘要".repeat(30_000));
  const h = await harness(t, state, { role: "worker", window: 8192 });
  const registered: string[] = [];
  viviMemoryExtension(state.options("worker"))({ on() {}, registerTool: (tool: { name: string }) => registered.push(tool.name) } as never);
  assert.deepEqual(registered.sort(), ["bot_memory_read", "bot_memory_search"]);
  state.source = { ...state.source!, role: "worker", kind: "result" };
  await h.session.prompt("read background");
  assert.ok(String(h.snapshots()[0].content).length <= 1024);
  assert.match(body(h.requests[0]), /Workers must never modify memory files/);
  assert.doesNotMatch(body(h.requests[0]), /bot_memory_update/);
});

test("SDK: unavailable source and read failures remove stale memory and fail open", async (t) => {
  const state = memoryState(), h = await harness(t, state);
  await h.session.prompt("first");
  state.source = undefined;
  await h.session.prompt("no source");
  assert.doesNotMatch(body(h.requests.at(-1)), /Original preference: tea/);
  state.source = { id: "input-3", conversationId: "router", requestId: "request-3", epoch: 1, kind: "input", role: "router", text: "third", createdAt: 1 };
  state.memory.context = async () => { throw new Error("unavailable"); };
  await h.session.prompt("unavailable memory");
  assert.doesNotMatch(body(h.requests.at(-1)), /Original preference: tea/);
});

test("small-window budget preserves complete index entries, explicit refs and bounded excerpt space", async () => {
  const state = memoryState();
  state.memory.context = async () => ({ root: "/memory", revision: "r1", summary: `## Preferences\n${"large-unbroken-preference".repeat(1000)}\n\n## What's in Memory\n- Release checklist: read MEMORY.md release section.\n- Deployment notes: read MEMORY.md deployment section.`, excerpts: [{ path: "MEMORY.md", revision: "r1", offset: 1, totalLines: 100, content: "huge-excerpt".repeat(2000) }] });
  const handlers = new Map<string, Function>();
  viviMemoryExtension({ ...state.options(), refs: () => [{ path: "MEMORY.md", heading: "Release checklist", offset: 1, limit: 120 }] })({ on: (name: string, fn: Function) => handlers.set(name, fn), registerTool() {} } as never);
  const response = await handlers.get("context")!({ messages: [] }, { model: { contextWindow: 8192 } });
  const content = response.messages[0].content;
  assert.ok(content.length <= 1024, `actual length ${content.length}`);
  assert.match(content, /What's in Memory/);
  assert.match(content, /Release checklist: read MEMORY.md release section\./);
  assert.match(content, /"heading":"Release checklist"/);
  assert.match(content, /Read MEMORY.md for the full index/);
  assert.doesNotMatch(content, /large-unbroken|huge-excerpt/);
});

test("late tool reads are discarded and search rejects revision changes", async () => {
  const state = memoryState(), h = hooks(state);
  const original = state.memory.read;
  state.memory.read = async (...args) => { const value = await original(...args); state.source = { ...state.source!, requestId: "next" }; return value; };
  await assert.rejects(h.tools.get("bot_memory_read").execute("read", { path: "MEMORY.md" }), /no longer current/);
  state.memory.search = async () => { state.change("r2", "new"); return [{ path: "MEMORY.md", line: 1, text: "old" }]; };
  await assert.rejects(h.tools.get("bot_memory_search").execute("search", { query: "old" }), /changed during this search/);
});

function hooks(state: ReturnType<typeof memoryState>) {
  const handlers = new Map<string, Function>(), tools = new Map<string, any>();
  viviMemoryExtension(state.options())({ on: (name: string, fn: Function) => handlers.set(name, fn), registerTool: (tool: any) => tools.set(tool.name, tool) } as never);
  return { handlers, tools };
}
test("cancel race: late context and updates cannot cross input/epoch; before hook needs no signal", async () => {
  const state = memoryState(), h = hooks(state);
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  const original = state.memory.context;
  state.memory.context = async () => { const context = await original(); await pending; return context; };
  const ctx = { model: { contextWindow: 100000 }, sessionManager: { buildSessionProjection: () => ({ messages: [] }) } };
  const read = h.handlers.get("before_agent_start")!({ systemPrompt: "base" }, ctx);
  state.source = { ...state.source!, epoch: 2, requestId: "new" };
  release();
  assert.equal(await read, undefined);
  let check!: () => boolean;
  state.memory.update = async (_input, _source, valid) => { check = valid; state.allowed = false; assert.equal(valid(), false); throw new Error("stale source"); };
  await assert.rejects(h.tools.get("bot_memory_update").execute("call", { expectedRevision: "r1", quote: "coffee", edits: [] }), /stale source/);
  assert.equal(check(), false);
  state.allowed = true; state.source = { ...state.source!, kind: "result" };
  await assert.rejects(h.tools.get("bot_memory_update").execute("call", {}), /current Vivi input/);
});

test("custom and native stale memory results are redacted while ordinary results stay untouched", async () => {
  const state = memoryState(), h = hooks(state);
  state.change("r2", "fresh");
  const ordinary = { role: "toolResult", toolName: "read", toolCallId: "ordinary", content: [{ type: "text", text: "ordinary output" }], details: {} };
  const messages = [ordinary, { role: "custom", customType: "memory-result", content: "old private detail", details: { viviMemory: { revision: "r1" } }, toolCallId: "custom-id" }, { role: "toolResult", toolName: "bot_memory_read", toolCallId: "native-id", content: [{ type: "text", text: "old private detail" }], details: { viviMemory: { revision: "r1" } } }];
  const result = await h.handlers.get("context")!({ messages }, { model: { contextWindow: 100000 } });
  assert.equal(result.messages[0], ordinary);
  assert.doesNotMatch(body(result), /old private detail/);
  assert.match(body(result), /custom-id/); assert.match(body(result), /native-id/);
  assert.equal("enabled" in state.options(), false, "Vivi has no global-memory switch dependency");
});
