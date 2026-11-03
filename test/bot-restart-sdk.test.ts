import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, type AgentSession, type ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { createFauxCore, fauxAssistantMessage, fauxToolCall, InMemoryModelsStore } from "@earendil-works/pi-ai";
import { botSessionExtension, type BotSessionService } from "../src/main/bot/bot-session-extension.ts";
import { runBotSession } from "../src/main/bot/bot-engine-host.ts";
import { BotRuntime } from "../src/main/bot/bot-runtime.ts";
import { BotStore } from "../src/main/bot/bot-store.ts";
import { openDatabaseConnection } from "../src/main/engine/db.ts";
import type { BotChanged, BotHost, BotConversationMeta } from "../src/shared/bot.ts";

type ContinueInput = Parameters<BotSessionService["continueConversation"]>[0];
type Responses = Parameters<ReturnType<typeof createFauxCore>["setResponses"]>[0];
const ROUTER = "router:1";
const WORKER = "worker:1";
const originalText = "在这个项目里执行一次操作，再核对并交付报告。";

function rootFor(t: TestContext): string {
  const root = mkdtempSync(join(tmpdir(), "vivi-restart-sdk-"));
  mkdirSync(join(root, "project"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function seed(store: BotStore, cwd: string): void {
  const meta: BotConversationMeta = { conversationId: ROUTER, role: "router", owner: "vivi", creationKey: "router:vivi", epoch: 0, paused: false, createdAt: 1, updatedAt: 1 };
  store.setRouterConversationId(ROUTER);
  store.putConversation(meta);
  store.putConversation({ ...meta, conversationId: WORKER, role: "worker", creationKey: "work:original-work", project: cwd, title: "检查原项目" });
  store.putInput({ id: "original-user", conversationId: ROUTER, epoch: 0, source: "user", text: originalText, status: "completed", createdAt: 1 });
  // The orchestration receipt is intentionally left running at the simulated
  // process-exit boundary; the actual SDK history below is persisted independently.
  store.putInput({ id: "original-work", conversationId: WORKER, epoch: 0, source: "router", text: originalText, rootInputId: "original-user", status: "running", createdAt: 2 });
}

const noService: BotSessionService = {
  contextFor: (id) => ({ conversationId: id, role: id === ROUTER ? "router" : "worker", active: true, phase: "running" }),
  submit: async () => ({}), routeMessage: async () => ({}), reply: async () => ({}), progress: async () => ({}),
  createWork: async () => ({}), report: async () => ({}), ask: async () => ({}),
  stopConversation: async () => ({}), continueConversation: async () => ({}),
};

function serviceFor(bot: () => BotRuntime, continued: ContinueInput[]): BotSessionService {
  return {
    contextFor: (id) => bot().contextFor(id), submit: (input) => bot().submit(input), routeMessage: (input) => bot().routeMessage(input),
    reply: (input) => bot().reply(input), progress: (input) => bot().progress(input), createWork: (input) => bot().createWork(input),
    report: (input) => bot().report(input), ask: (input) => bot().ask(input), stopConversation: (input) => bot().stopConversation(input),
    continueConversation: (input) => { continued.push(input); return bot().continueConversation(input); },
  };
}

async function openSdk(root: string, id: string, manager: SessionManager, responses: Responses, service: BotSessionService = noService, extra?: ExtensionFactory): Promise<AgentSession> {
  const cwd = join(root, "project");
  const agentDir = join(root, "agent");
  const faux = createFauxCore({ api: "faux-api", provider: "faux", models: [{ id: "scripted" }] });
  faux.setResponses(responses);
  const runtime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: null, modelsStore: new InMemoryModelsStore(), allowModelNetwork: false, refreshOnCreate: false });
  runtime.registerProvider("faux", {
    baseUrl: "http://faux.invalid", api: "faux-api" as never, apiKey: "unused", streamSimple: faux.streamSimple as never,
    models: [{ id: "scripted", name: "scripted", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100_000, maxTokens: 4096 }],
  });
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
  const resourceLoader = new DefaultResourceLoader({
    cwd, agentDir, settingsManager, noSkills: true, noContextFiles: true, noExtensions: true,
    extensionFactories: [
      { name: "vivi", factory: botSessionExtension({ role: id === ROUTER ? "router" : "worker", conversationId: id, service, projects: () => [{ cwd, name: "原项目" }] }) },
      ...(extra ? [{ name: "test-effects", factory: extra }] : []),
    ],
  });
  await resourceLoader.reload();
  const { session } = await createAgentSession({ cwd, agentDir, modelRuntime: runtime, model: runtime.getModel("faux", "scripted"), sessionManager: manager, settingsManager, resourceLoader });
  await session.bindExtensions({ mode: "rpc" });
  return session;
}

function hostFor(sessions: Map<string, AgentSession>, cwd: string, events: BotChanged[], executions: string[]): BotHost {
  return {
    createConversation: async () => { throw new Error("恢复不得创建替代 Worker 或 Router"); },
    execute: async (input) => {
      executions.push(input.conversationId);
      const session = sessions.get(input.conversationId);
      assert.ok(session, `未知会话 ${input.conversationId}`);
      assert.equal(session.sessionManager.getCwd(), cwd);
      return runBotSession(session, input.text, { signal: input.signal, images: input.images, timeoutMs: 5000, abort: () => session.abort() });
    },
    abort: async (id) => { await sessions.get(id)?.abort(); },
    snapshot: async () => { throw new Error("unused"); }, messages: async () => [],
    resolveProject: () => cwd, changed: (event) => events.push(event),
  };
}

async function until(check: () => boolean, diagnose?: () => unknown): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`Vivi startup inspection did not settle: ${JSON.stringify(diagnose?.())}`);
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

for (const continueFromTool of [true, false]) test(`真实 SDK 重开磁盘会话：Router ${continueFromTool ? "调用继续工具" : "检查后遗漏继续工具"}，原 Worker 核对已有操作后只交付一次`, async (t) => {
  const root = rootFor(t);
  const cwd = join(root, "project");
  const dbFile = join(root, "state.db");
  const effectFile = join(cwd, "effect-count.txt");
  let db = openDatabaseConnection(dbFile);
  seed(new BotStore(db), cwd);
  const firstRouter = await openSdk(root, ROUTER, SessionManager.create(cwd, join(root, "router-sessions")), [fauxAssistantMessage("已安排原工作。")]);
  const firstWorker = await openSdk(root, WORKER, SessionManager.create(cwd, join(root, "worker-sessions")), [
    fauxAssistantMessage([fauxToolCall("one_time_effect", {}, { id: "effect-before-exit" })], { stopReason: "toolUse" }),
    fauxAssistantMessage("不应走到这里"),
  ], noService, (pi) => {
    // Keep the same tool catalogue across reopen: the SDK restores the session's
    // enabled tool names from its transcript, just as the production host does.
    pi.registerTool({ name: "inspect_effect", label: "Inspect existing effect", description: "Read the actual result without repeating its effect", parameters: Type.Object({}), execute: async () => ({ content: [{ type: "text", text: `effect count: ${readFileSync(effectFile, "utf8")}` }] }) });
    pi.registerTool({ name: "one_time_effect", label: "Execute once", description: "Perform one external effect", parameters: Type.Object({}), execute: async () => {
      const count = existsSync(effectFile) ? Number(readFileSync(effectFile, "utf8")) : 0;
      writeFileSync(effectFile, String(count + 1));
      return { content: [{ type: "text", text: "EXTERNAL_EFFECT_ALREADY_COMPLETED" }] };
    } });
  });
  assert.ok(firstWorker.getActiveToolNames().includes("one_time_effect"));
  assert.ok(firstWorker.getActiveToolNames().includes("inspect_effect"), "检查工具在首次会话初始化时已启用并持久化");
  const controller = new AbortController();
  const unsubscribe = firstWorker.subscribe((event) => { if (event.type === "tool_execution_end" && event.toolName === "one_time_effect") controller.abort(); });
  try {
    await firstRouter.prompt(originalText);
    const interrupted = await runBotSession(firstWorker, originalText, { signal: controller.signal, timeoutMs: 5000, abort: () => firstWorker.abort() });
    assert.equal(interrupted.status, "interrupted");
  } finally { unsubscribe(); }
  const routerFile = firstRouter.sessionFile!;
  const workerFile = firstWorker.sessionFile!;
  const workerSessionId = firstWorker.sessionManager.getSessionId();
  assert.ok(readFileSync(workerFile, "utf8").includes("EXTERNAL_EFFECT_ALREADY_COMPLETED"), "退出前的真实工具结果已经落盘");
  assert.equal(readFileSync(effectFile, "utf8"), "1");
  firstRouter.dispose(); firstWorker.dispose(); db.close();

  db = openDatabaseConnection(dbFile);
  const store = new BotStore(db);
  const sessions = new Map<string, AgentSession>();
  const events: BotChanged[] = [];
  const executions: string[] = [];
  const continued: ContinueInput[] = [];
  let bot!: BotRuntime;
  const service = serviceFor(() => bot, continued);
  const router = await openSdk(root, ROUTER, SessionManager.open(routerFile), [
    (context) => {
      assert.match(JSON.stringify(context.messages), /Automatically inspect these interrupted Worker/);
      assert.match(JSON.stringify(context.messages), /worker:1/);
      return fauxAssistantMessage([fauxToolCall("bot_read_context", {})], { stopReason: "toolUse" });
    },
    (context) => {
      const tool = context.messages.findLast((message) => message.role === "toolResult");
      assert.match(JSON.stringify(tool), /restartRecovery/);
      return fauxAssistantMessage([fauxToolCall(continueFromTool ? "bot_continue_conversation" : "bot_reply", continueFromTool ? { conversationId: WORKER } : { text: "我检查过中断记录，接着原来的工作处理。" })], { stopReason: "toolUse" });
    },
    ...(continueFromTool ? [fauxAssistantMessage([fauxToolCall("bot_reply", { text: "我检查过中断记录，已经接着原来的工作处理。" })], { stopReason: "toolUse" })] : []),
    (context) => {
      assert.match(JSON.stringify(context.messages), /报告核对完成/);
      return fauxAssistantMessage([fauxToolCall("bot_reply", { text: "报告核对完成，原有操作没有重复执行。" })], { stopReason: "toolUse" });
    },
  ], service);
  let inspected = false;
  const worker = await openSdk(root, WORKER, SessionManager.open(workerFile), [
    (context) => {
      const messages = JSON.stringify(context.messages);
      assert.match(messages, /EXTERNAL_EFFECT_ALREADY_COMPLETED/);
      assert.match(messages, /Inspect the existing conversation, actual workspace files and external effects first/);
      assert.ok(messages.includes(originalText), "恢复仍携带原始要求");
      return fauxAssistantMessage([fauxToolCall("inspect_effect", {})], { stopReason: "toolUse" });
    },
    (context) => {
      const inspectionResult = JSON.stringify(context.messages.findLast((message) => message.role === "toolResult"));
      assert.equal(inspected, true, `必须先实际核对文件，再报告完成；工具返回 ${inspectionResult}`);
      assert.match(inspectionResult, /effect count: 1/);
      return fauxAssistantMessage([fauxToolCall("bot_report", { outcome: "ready", summary: "报告核对完成", evidence: ["原操作计数仍为 1"], artifacts: [effectFile] })], { stopReason: "toolUse" });
    },
  ], service, (pi) => {
    pi.registerTool({ name: "inspect_effect", label: "Inspect existing effect", description: "Read the actual result without repeating its effect", parameters: Type.Object({}), execute: async () => {
      inspected = true;
      return { content: [{ type: "text", text: `effect count: ${readFileSync(effectFile, "utf8")}` }] };
    } });
  });
  assert.ok(worker.getActiveToolNames().includes("inspect_effect"), "SDK 重开后恢复了检查工具的启用状态");
  sessions.set(ROUTER, router); sessions.set(WORKER, worker);
  bot = new BotRuntime(store, hostFor(sessions, cwd, events, executions));
  t.after(async () => { await bot.stop(); router.dispose(); worker.dispose(); db.close(); });
  assert.equal(worker.sessionManager.getSessionId(), workerSessionId);
  assert.equal(worker.sessionFile, workerFile);
  bot.start();
  bot.start();
  await until(() => store.deliveries("delivered").length === 1 && !bot.activity().running, () => ({ inputs: store.inputs().map(({ id, status, error }) => ({ id, status, error: error?.slice(0, 1000) })), continued, executions }));
  const checks = store.inputs(ROUTER).filter((input) => input.restartTargets);
  assert.equal(checks.length, 1, "重复 start 不重复安排检查");
  assert.deepEqual(checks[0].restartTargets, [{ conversationId: WORKER, epoch: 0, inputId: "original-work" }]);
  assert.equal(checks[0].status, "completed");
  assert.deepEqual(continued, continueFromTool ? [{ conversationId: WORKER, callerConversationId: ROUTER, callerRequestId: checks[0].id, callerEpoch: checks[0].epoch, targetEpoch: 0 }] : [], "真实工具桥携带调用方、请求和代次；省略工具时由运行时补齐");
  assert.equal(executions.filter((id) => id === WORKER).length, 1);
  assert.equal(store.conversations().length, 2);
  assert.equal(store.conversation(WORKER)?.project, cwd);
  assert.equal(store.input("original-work")?.status, "uncertain", "旧输入不伪装成重放成功");
  const resumed = store.inputs(WORKER).find((input) => input.recoveryOf === "original-work");
  assert.equal(resumed?.status, "completed");
  assert.equal(resumed?.conversationId, WORKER);
  assert.equal(readFileSync(effectFile, "utf8"), "1");
  assert.equal(store.results(WORKER).at(-1)?.status, "ready");
  assert.equal(events.filter((event) => event.completion).length, 1);
});

test("真实 SDK 的迟到恢复工具保留 callerConversationId，用户停止后的 Worker 不会被重启检查复活", async (t) => {
  const root = rootFor(t);
  const cwd = join(root, "project");
  const db = openDatabaseConnection(join(root, "state.db"));
  const store = new BotStore(db);
  seed(store, cwd);
  let bot!: BotRuntime;
  const sessions = new Map<string, AgentSession>();
  const executions: string[] = [];
  const continued: ContinueInput[] = [];
  const router = await openSdk(root, ROUTER, SessionManager.create(cwd, join(root, "router-sessions")), [
    fauxAssistantMessage([fauxToolCall("bot_read_context", {})], { stopReason: "toolUse" }),
    () => {
      // Simulate a user pressing Stop after the model read context but before its
      // continuation call reaches the tool bridge. Stop persists synchronously.
      void bot.stopConversation({ conversationId: WORKER });
      assert.equal(store.conversation(WORKER)?.epoch, 1);
      return fauxAssistantMessage([fauxToolCall("bot_continue_conversation", { conversationId: WORKER })], { stopReason: "toolUse" });
    },
    fauxAssistantMessage([fauxToolCall("bot_reply", { text: "这项工作已停止。" })], { stopReason: "toolUse" }),
  ], serviceFor(() => bot, continued));
  sessions.set(ROUTER, router);
  bot = new BotRuntime(store, hostFor(sessions, cwd, [], executions));
  t.after(async () => { await bot.stop(); router.dispose(); db.close(); });
  bot.start();
  await until(() => store.inputs(ROUTER).some((input) => input.restartTargets && input.status === "completed") && !bot.activity().running, () => ({ inputs: store.inputs().map(({ id, status, error }) => ({ id, status, error: error?.slice(0, 1000) })), continued, executions }));
  const inspection = store.inputs(ROUTER).find((input) => input.restartTargets)!;
  assert.deepEqual(continued, [{ conversationId: WORKER, callerConversationId: ROUTER, callerRequestId: inspection.id, callerEpoch: inspection.epoch, targetEpoch: 0 }]);
  assert.deepEqual(executions, [ROUTER], "旧恢复工具和检查结束时的兜底均不能启动 Worker");
  assert.equal(store.conversation(WORKER)?.paused, true);
  assert.equal(store.conversation(WORKER)?.restartRecovery, undefined);
  assert.equal(store.inputs(WORKER).some((input) => input.source === "resume"), false);
  bot.start();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(executions, [ROUTER]);
});

test("真实 SDK 普通 Router 回合读取目标 epoch 后，用户停止 Worker 会拒绝迟到的继续工具", async (t) => {
  const root = rootFor(t);
  const cwd = join(root, "project");
  const db = openDatabaseConnection(join(root, "state.db"));
  const store = new BotStore(db);
  seed(store, cwd);
  store.putInput({ ...store.input("original-work")!, status: "completed" });
  store.putConversation({ ...store.conversation(WORKER)!, paused: true });
  const requestId = "ordinary-router-request";
  let bot!: BotRuntime;
  const sessions = new Map<string, AgentSession>();
  const executions: string[] = [];
  const continued: ContinueInput[] = [];
  let sawContext = false;
  const router = await openSdk(root, ROUTER, SessionManager.create(cwd, join(root, "router-sessions")), [
    (context) => {
      const input = store.input(requestId)!;
      assert.equal(input.status, "running");
      assert.equal(input.restartTargets, undefined, "普通用户回合没有重启检查目标保护");
      const messages = JSON.stringify(context.messages);
      assert.match(messages, /Current Vivi conversation state:/, "模型实际读到请求时的会话上下文");
      assert.match(messages, /worker:1/);
      assert.equal(store.conversation(WORKER)?.epoch, 0);
      sawContext = true;
      // The request context has already captured epoch 0. Stop changes the
      // target before the returned tool call is executed by the real SDK.
      void bot.stopConversation({ conversationId: WORKER });
      assert.equal(store.conversation(WORKER)?.epoch, 1);
      return fauxAssistantMessage([fauxToolCall("bot_continue_conversation", { conversationId: WORKER })], { stopReason: "toolUse" });
    },
    fauxAssistantMessage([fauxToolCall("bot_reply", { text: "这项工作已停止。" })], { stopReason: "toolUse" }),
  ], serviceFor(() => bot, continued));
  sessions.set(ROUTER, router);
  bot = new BotRuntime(store, hostFor(sessions, cwd, [], executions));
  t.after(async () => { await bot.stop(); router.dispose(); db.close(); });
  bot.start();
  await bot.submit({ requestId, text: "继续原来的工作。" });
  await until(() => store.input(requestId)?.status === "completed" && !bot.activity().running, () => ({ inputs: store.inputs(), continued, executions }));
  assert.equal(sawContext, true);
  assert.equal(store.inputs(ROUTER).some((input) => input.restartTargets), false);
  assert.deepEqual(continued, [{ conversationId: WORKER, callerConversationId: ROUTER, callerRequestId: requestId, callerEpoch: 0, targetEpoch: 0 }], "目标代次来自模型已读的 context，不能在工具执行时改读为 1");
  assert.deepEqual(executions, [ROUTER], "迟到的真实工具不能启动已停止的 Worker");
  assert.equal(store.conversation(WORKER)?.paused, true);
  assert.equal(store.conversation(WORKER)?.epoch, 1);
  assert.equal(store.inputs(WORKER).some((input) => input.source === "resume"), false);
});
