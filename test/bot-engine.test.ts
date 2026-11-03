import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, type ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { createFauxCore, fauxAssistantMessage, fauxToolCall, InMemoryModelsStore } from "@earendil-works/pi-ai";
import { botSessionExtension, botToolAllowed, type BotSessionService } from "../src/main/bot/bot-session-extension.ts";
import { runBotSession } from "../src/main/bot/bot-engine-host.ts";
import type { BotExecutionOutcome, BotHost } from "../src/shared/bot.ts";
import type { PromptImage } from "../src/shared/types.ts";
import { openDatabase } from "../src/main/engine/db.ts";
import { BotStore } from "../src/main/bot/bot-store.ts";
import { BotRuntime } from "../src/main/bot/bot-runtime.ts";

async function harness(t: TestContext, responses: Parameters<ReturnType<typeof createFauxCore>["setResponses"]>[0], role: "router" | "worker" = "worker", extra?: ExtensionFactory, serviceOverride?: Partial<BotSessionService>) {
  const dir = mkdtempSync(join(tmpdir(), "vivi-engine-")); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const faux = createFauxCore({ api: "faux-api", provider: "faux", models: [{ id: "scripted" }] }); faux.setResponses(responses);
  const runtime = await ModelRuntime.create({ authPath: join(dir, "auth.json"), modelsPath: null, modelsStore: new InMemoryModelsStore(), allowModelNetwork: false, refreshOnCreate: false });
  runtime.registerProvider("faux", { baseUrl: "http://faux.invalid", api: "faux-api" as never, apiKey: "unused", streamSimple: faux.streamSimple as never, models: [{ id: "scripted", name: "scripted", reasoning: false, input: ["text", "image"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 4096 }] });
  let reports = 0;
  const service: BotSessionService = {
    contextFor: (conversationId) => ({ role, conversationId, active: true, phase: reports ? "reported" : "running" }),
    submit: async () => ({}), routeMessage: async () => ({}), reply: async () => ({}), progress: async () => ({}), createWork: async () => ({}),
    report: async () => { reports++; return {}; }, ask: async () => ({}),
    stopConversation: async () => ({}), continueConversation: async () => ({}),
    ...serviceOverride,
  };
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
  const resourceLoader = new DefaultResourceLoader({ cwd: dir, agentDir: dir, settingsManager, noSkills: true, noContextFiles: true, noExtensions: true, extensionFactories: [{ name: "vivi", factory: botSessionExtension({ role, conversationId: role === "router" ? "router:1" : "worker:1", service, projects: () => [] }) }, ...(extra ? [{ name: "test", factory: extra }] : [])] });
  await resourceLoader.reload();
  const { session } = await createAgentSession({ cwd: dir, agentDir: dir, modelRuntime: runtime, model: runtime.getModel("faux", "scripted"), sessionManager: SessionManager.inMemory(dir), settingsManager, resourceLoader });
  await session.bindExtensions({ mode: "rpc" }); t.after(() => session.dispose());
  const run = (text = "执行工作", timeoutMs = 5000, images?: PromptImage[]): Promise<BotExecutionOutcome> => runBotSession(session, text, { images, signal: new AbortController().signal, timeoutMs, abort: () => session.abort() });
  return { session, run, get reports() { return reports; } };
}

test("structured bot_report 结束 SDK 回合且不要求 prose", async (t) => {
  const h = await harness(t, [fauxAssistantMessage([fauxToolCall("bot_report", { outcome: "ready", summary: "完成", evidence: ["已检查"], artifacts: [] })], { stopReason: "toolUse" })]);
  const result = await h.run(); assert.equal(result.status, "completed"); assert.equal(result.text, ""); assert.equal(h.reports, 1); assert.equal(h.session.isIdle, true);
});

test("Router 的 bot_reply 写入用户反馈并结束当前回合", async (t) => {
  let replies = 0;
  const h = await harness(t, [fauxAssistantMessage([fauxToolCall("bot_reply", { text: "已安排，稍后告诉你结果。" })], { stopReason: "toolUse" })], "router", undefined, {
    reply: async (input) => { replies++; return { id: "chat:assistant:1", conversationId: input.conversationId, role: "assistant", text: input.text, createdAt: 1 }; },
  });
  const result = await h.run();
  assert.equal(result.status, "completed");
  assert.equal(result.text, "");
  assert.equal(replies, 1);
  assert.equal(h.session.isIdle, true);
});

test("Host runner 等待完整 prompt、不会复用上一轮 assistant", async (t) => {
  let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; }); let prompts = 0;
  const h = await harness(t, [fauxAssistantMessage("旧"), fauxAssistantMessage("新")], "worker", (pi) => { pi.on("before_agent_start", async () => { if (++prompts === 2) await gate; }); });
  assert.equal((await h.run()).text, "旧"); const pending = h.run(); await new Promise((resolve) => setTimeout(resolve, 20)); release(); assert.equal((await pending).text, "新");
});


test("超时取消 preflight 并返回 failed", async (t) => {
  const h = await harness(t, [fauxAssistantMessage("不会完成")], "worker", (pi) => { pi.on("before_agent_start", async () => { await new Promise((resolve) => setTimeout(resolve, 30)); }); });
  const result = await h.run("超时", 5); assert.equal(result.status, "failed"); assert.match(result.error ?? "", /timed out/); assert.equal(h.session.isIdle, true);
});

test("Router/Worker 工具白名单符合会话角色", () => {
  for (const name of ["spawn_agent", "question", "dag_add_tasks", "worktree_create", "fastvibe_config_apply"]) { assert.equal(botToolAllowed("worker", name), false); assert.equal(botToolAllowed("router", name), false); }
  for (const name of ["read", "bash", "codemode", "tool_search", "bot_report", "bot_ask_user"]) assert.equal(botToolAllowed("worker", name), true);
  for (const role of ["router", "worker"] as const) assert.equal(botToolAllowed(role, "bot_progress"), true);
  assert.equal(botToolAllowed("router", "bot_create_work"), true); assert.equal(botToolAllowed("router", "codemode"), false);
  assert.equal(botToolAllowed("router", "bot_send_message"), true); assert.equal(botToolAllowed("router", "bot_reply"), true); assert.equal(botToolAllowed("worker", "bot_send_message"), false);
});

test("报告后 tool_call 被 sealed，且 context 注入当前会话状态", async (t) => {
  const h = await harness(t, [fauxAssistantMessage([fauxToolCall("bot_report", { outcome: "ready", summary: "已完成", evidence: [], artifacts: [] })], { stopReason: "toolUse" })], "worker", (pi) => {
    pi.registerTool({ name: "after_report", label: "after", description: "after", parameters: { type: "object", properties: {} } as never, execute: async () => ({ content: [{ type: "text", text: "bad" }] }) });
    pi.on("context", (event) => { assert.ok(event.messages.some((message) => message.role === "custom" && message.customType === "vivi-live-context")); });
  });
  await h.run(); assert.equal(h.reports, 1); assert.equal(h.session.isIdle, true);
});

test("纯图片输入经 Host runner 进入真实 SDK 提供方请求", async (t) => {
  const images: PromptImage[] = [{ type: "image", mimeType: "image/png", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==" }];
  let received: unknown;
  const h = await harness(t, [(context) => {
    received = context.messages.filter((message) => message.role === "user").flatMap((message) => message.content);
    return fauxAssistantMessage("看到图片了");
  }]);
  assert.equal((await h.run("", 5000, images)).status, "completed");
  assert.ok(Array.isArray(received));
  assert.deepEqual(received.filter((part) => part.type === "image"), images);
});

test("真实 SDK Router 将补充要求送入原 Worker，且不新增会话", async (t) => {
  const db = openDatabase(":memory:");
  const store = new BotStore(db);
  let bot!: BotRuntime;
  let workers = 0;
  const workerTexts: string[] = [];
  const worker = await harness(t, [fauxAssistantMessage("初稿"), fauxAssistantMessage("已补英文摘要")]);
  const router = await harness(t, [
    fauxAssistantMessage([fauxToolCall("bot_create_work", { requestId: "work-1", title: "报告", text: "写报告" })], { stopReason: "toolUse" }),
    fauxAssistantMessage("已安排"),
    (context) => {
      assert.match(JSON.stringify(context.messages), /worker:1/);
      return fauxAssistantMessage([fauxToolCall("bot_send_message", { conversationId: "worker:1", requestId: "supplement-1", text: "给刚才的报告加一段英文摘要" })], { stopReason: "toolUse" });
    },
    fauxAssistantMessage("已补充到原工作会话"),
  ], "router", undefined, {
    contextFor: (id) => bot.contextFor(id),
    submit: (input) => bot.submit(input),
    routeMessage: (input) => bot.routeMessage(input),
    reply: (input) => bot.reply(input),
    progress: (input) => bot.progress(input),
    createWork: (input) => bot.createWork(input),
  });
  const host: BotHost = {
    createConversation: async ({ kind }) => ({ conversationId: kind === "router" ? "router:1" : `worker:${++workers}` }),
    execute: async (input) => {
      const session = input.conversationId === "router:1" ? router.session : worker.session;
      if (input.conversationId !== "router:1") workerTexts.push(input.text);
      return runBotSession(session, input.text, { images: input.images, signal: input.signal, timeoutMs: 5000, abort: () => session.abort() });
    },
    snapshot: async () => { throw new Error("unused"); }, messages: async () => [],
    abort: async (id) => (id === "router:1" ? router.session : worker.session).abort(),
    resolveProject: () => "/output", changed: () => {},
  };
  bot = new BotRuntime(store, host);
  const settled = async (id: string) => {
    for (let i = 0; i < 1000; i++) {
      if (["completed", "failed"].includes(store.input(id)?.status ?? "")) { assert.equal(store.input(id)?.status, "completed", store.input(id)?.error); return; }
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    throw new Error(`Input ${id} did not settle`);
  };
  try {
    bot.start();
    await bot.submit({ requestId: "user-1", text: "写报告" });
    await settled("user-1"); await settled("work-1");
    await bot.submit({ requestId: "user-2", text: "给刚才那个工作再加一段英文摘要" });
    await settled("user-2"); await settled("supplement-1");
    assert.equal(workers, 1);
    assert.equal(store.conversations().length, 2);
    assert.equal(store.input("supplement-1")?.conversationId, "worker:1");
    assert.deepEqual(workerTexts, ["写报告", "给刚才的报告加一段英文摘要"]);
  } finally { await bot.stop(); db.close(); }
});
