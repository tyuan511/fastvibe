import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, type AgentSession } from "@earendil-works/pi-coding-agent";
import { createFauxCore, fauxAssistantMessage, fauxToolCall, InMemoryModelsStore } from "@earendil-works/pi-ai";
import { openDatabase } from "../src/main/engine/db.ts";
import { BotStore } from "../src/main/bot/bot-store.ts";
import { BotRuntime } from "../src/main/bot/bot-runtime.ts";
import { botSessionExtension } from "../src/main/bot/bot-session-extension.ts";
import { runBotSession } from "../src/main/bot/bot-engine-host.ts";
import { ViviMemoryService } from "../src/main/bot/memory/service.ts";
import { viviMemoryExtension } from "../src/main/bot/memory/extension.ts";
import { viviMemorySources } from "../src/main/bot/memory/sources.ts";
import type { ViviMemorySource } from "../src/main/bot/memory/types.ts";

async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 2000; i++) { if (check()) return; await new Promise<void>((resolve) => setTimeout(resolve, 2)); }
  throw new Error("Vivi input did not settle");
}

test("真实SDK Router记住约定后分派Worker，后续新会话和重开服务继续读取Markdown", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "vivi-memory-integrated-"));
  const db = openDatabase(":memory:");
  const store = new BotStore(db);
  let bot!: BotRuntime;
  const sessions = new Map<string, AgentSession>();
  let workerCount = 0;
  let workerRequests = 0;
  const complete = async () => { throw new Error("Explicit remembering must not issue a background model request"); };
  const memory = new ViviMemoryService({ root: join(dir, "memories"), sources: () => viviMemorySources({ conversations: store.conversations(), inputs: store.inputs(), results: store.results() }), complete, consolidate: async () => {}, debounceMs: 60_000 });
  const current = (id: string): ViviMemorySource | undefined => {
    const context = bot.contextFor(id);
    const input = context.input ? store.input(context.input.requestId) : undefined;
    const meta = store.conversation(id);
    if (!context.active || !input || !meta) return undefined;
    return { id: `input:${input.id}`, conversationId: id, requestId: input.id, epoch: input.epoch, createdAt: input.createdAt, role: meta.role, kind: input.source === "user" ? "input" : "result", text: input.text };
  };
  const valid = (source: ViviMemorySource) => { const active = current(source.conversationId); return active?.requestId === source.requestId && active.epoch === source.epoch; };
  const makeSession = async (id: string, role: "router" | "worker") => {
    const faux = createFauxCore({ api: "faux-api", provider: "faux", models: [{ id: "scripted" }] });
    if (role === "router") faux.setResponses([
      (context) => {
        const revision = /Revision: ([a-f0-9]{64})/.exec(JSON.stringify(context))?.[1];
        assert.ok(revision, "Router must see the actual Markdown revision");
        return fauxAssistantMessage([fauxToolCall("bot_memory_update", { expectedRevision: revision, quote: "以后周报都按已完成、风险、下一步排列", edits: [
          { path: "MEMORY.md", oldText: "# Vivi memory\n", newText: "# Vivi memory\n\n## 周报\n默认按已完成、风险、下一步排列。\n" },
          { path: "memory_summary.md", oldText: "v1\n\n## Memory index\n", newText: "v1\n\n## 用户偏好\n周报按已完成、风险、下一步排列。\n\n## Memory index\n周报：见 MEMORY.md 的周报章节。\n" },
        ] })], { stopReason: "toolUse" });
      },
      fauxAssistantMessage([fauxToolCall("bot_create_work", { requestId: "work-first", title: "本周周报", text: "整理本周周报", memoryRefs: [{ path: "MEMORY.md", heading: "周报" }] })], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxToolCall("bot_reply", { text: "已记住周报格式，正在整理。" })], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxToolCall("bot_reply", { text: "周报已整理。" })], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxToolCall("bot_reply", { text: "下周周报也已整理。" })], { stopReason: "toolUse" }),
    ]);
    else faux.setResponses([(context) => {
      workerRequests++;
      const sent = JSON.stringify(context);
      assert.match(sent, /已完成、风险、下一步/);
      assert.match(sent, /Vivi memory context/);
      assert.equal(sent.includes("OLD_MEMORY_THAT_SHOULD_NOT_EXIST"), false);
      return fauxAssistantMessage([fauxToolCall("bot_report", { outcome: "ready", summary: "周报已整理", evidence: [], artifacts: [] })], { stopReason: "toolUse" });
    }]);
    const runtime = await ModelRuntime.create({ authPath: join(dir, `${id}-auth.json`), modelsPath: null, modelsStore: new InMemoryModelsStore(), allowModelNetwork: false, refreshOnCreate: false });
    runtime.registerProvider("faux", { baseUrl: "http://faux.invalid", api: "faux-api" as never, apiKey: "unused", streamSimple: faux.streamSimple as never, models: [{ id: "scripted", name: "scripted", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 4096 }] });
    const settings = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
    const loader = new DefaultResourceLoader({ cwd: dir, agentDir: dir, settingsManager: settings, noExtensions: true, noSkills: true, noContextFiles: true, extensionFactories: [
      { name: "memory", factory: viviMemoryExtension({ memory, role, source: () => current(id), refs: () => { const input = bot.contextFor(id).input; return input ? store.input(input.requestId)?.memoryRefs ?? [] : []; }, valid }) },
      { name: "bot", factory: botSessionExtension({ role, conversationId: id, projects: () => [], service: { contextFor: (target) => bot.contextFor(target), submit: (input) => bot.submit(input), routeMessage: (input) => bot.routeMessage(input), createWork: (input) => bot.createWork(input), reply: (input) => bot.reply(input), report: (input) => bot.report(input), ask: (input) => bot.ask(input), progress: (input) => bot.progress(input), stopConversation: (input) => bot.stopConversation(input), continueConversation: (input) => bot.continueConversation(input) } }) },
    ] });
    await loader.reload();
    const { session } = await createAgentSession({ cwd: dir, agentDir: dir, modelRuntime: runtime, model: runtime.getModel("faux", "scripted"), sessionManager: SessionManager.inMemory(dir), settingsManager: settings, resourceLoader: loader });
    await session.bindExtensions({ mode: "rpc" });
    sessions.set(id, session);
    return session;
  };
  bot = new BotRuntime(store, {
    createConversation: async ({ kind }) => { const id = kind === "router" ? "router" : `worker-${++workerCount}`; await makeSession(id, kind); return { conversationId: id }; },
    execute: (input) => { const session = sessions.get(input.conversationId)!; return runBotSession(session, input.text, { signal: input.signal, abort: () => session.abort(), timeoutMs: 5000 }); },
    snapshot: async () => { throw new Error("unused"); }, messages: async () => [], abort: async (id) => { await sessions.get(id)?.abort(); }, resolveProject: () => dir, changed: () => {}, settled: () => memory.notify(),
  });
  t.after(async () => { await memory.stop(); await bot.stop(); for (const session of sessions.values()) session.dispose(); db.close(); rmSync(dir, { recursive: true, force: true }); });
  memory.start();
  await memory.context();
  bot.start();
  await bot.submit({ requestId: "remember", text: "以后周报都按已完成、风险、下一步排列，整理本周周报" });
  await until(() => store.input("work-first")?.status === "completed" && !bot.activity().running);
  assert.equal(store.input("remember")?.status, "completed", store.input("remember")?.error);
  assert.deepEqual(store.input("work-first")?.memoryRefs, [{ path: "MEMORY.md", heading: "周报" }]);
  assert.equal(workerRequests, 1);
  assert.match((await memory.read("MEMORY.md")).content, /已完成、风险、下一步/);
  await memory.stop();
  const reopened = new ViviMemoryService({ root: join(dir, "memories"), sources: () => [], complete, consolidate: async () => {} });
  reopened.start();
  assert.match((await reopened.context([{ path: "MEMORY.md", heading: "周报" }])).excerpts[0].content, /已完成、风险、下一步/);
  await reopened.stop();
  // A new unrelated SDK session still obtains the persisted convention without Router history.
  const worker = await bot.createWork({ requestId: "work-next", title: "下周周报", text: "整理下周周报", memoryRefs: [{ path: "MEMORY.md", heading: "周报" }] });
  await until(() => store.input("work-next")?.status === "completed" && !bot.activity().running);
  assert.equal(worker.conversationId, "worker-2");
  assert.equal(workerRequests, 2);
  assert.equal(store.inputs().some((input) => input.status === "failed"), false);
});
