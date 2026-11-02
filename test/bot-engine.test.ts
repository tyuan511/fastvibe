import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, type ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { createFauxCore, fauxAssistantMessage, fauxToolCall, InMemoryModelsStore } from "@earendil-works/pi-ai";
import { botSessionExtension, botToolAllowed, type BotSessionService } from "../src/main/bot/bot-session-extension.ts";
import { runBotSession } from "../src/main/bot/bot-engine-host.ts";
import type { BotExecutionOutcome } from "../src/shared/bot.ts";

async function harness(t: TestContext, responses: Parameters<ReturnType<typeof createFauxCore>["setResponses"]>[0], role: "router" | "worker" = "worker", extra?: ExtensionFactory) {
  const dir = mkdtempSync(join(tmpdir(), "vivi-engine-")); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const faux = createFauxCore({ api: "faux-api", provider: "faux", models: [{ id: "scripted" }] }); faux.setResponses(responses);
  const runtime = await ModelRuntime.create({ authPath: join(dir, "auth.json"), modelsPath: null, modelsStore: new InMemoryModelsStore(), allowModelNetwork: false, refreshOnCreate: false });
  runtime.registerProvider("faux", { baseUrl: "http://faux.invalid", api: "faux-api" as never, apiKey: "unused", streamSimple: faux.streamSimple as never, models: [{ id: "scripted", name: "scripted", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 4096 }] });
  let reports = 0;
  const service: BotSessionService = {
    contextFor: (conversationId) => ({ role, conversationId, active: true, phase: reports ? "reported" : "running" }),
    submit: async () => ({}), createWork: async () => ({}),
    report: async () => { reports++; return {}; }, ask: async () => ({}),
    stopConversation: async () => ({}), continueConversation: async () => ({}),
  };
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
  const resourceLoader = new DefaultResourceLoader({ cwd: dir, agentDir: dir, settingsManager, noSkills: true, noContextFiles: true, noExtensions: true, extensionFactories: [{ name: "vivi", factory: botSessionExtension({ role, conversationId: "worker:1", service, projects: () => [] }) }, ...(extra ? [{ name: "test", factory: extra }] : [])] });
  await resourceLoader.reload();
  const { session } = await createAgentSession({ cwd: dir, agentDir: dir, modelRuntime: runtime, model: runtime.getModel("faux", "scripted"), sessionManager: SessionManager.inMemory(dir), settingsManager, resourceLoader });
  await session.bindExtensions({ mode: "rpc" }); t.after(() => session.dispose());
  const run = (text = "执行工作", timeoutMs = 5000): Promise<BotExecutionOutcome> => runBotSession(session, text, { signal: new AbortController().signal, timeoutMs, abort: () => session.abort() });
  return { session, run, get reports() { return reports; } };
}

test("structured bot_report 结束 SDK 回合且不要求 prose", async (t) => {
  const h = await harness(t, [fauxAssistantMessage([fauxToolCall("bot_report", { outcome: "ready", summary: "完成", evidence: ["已检查"], artifacts: [] })], { stopReason: "toolUse" })]);
  const result = await h.run(); assert.equal(result.status, "completed"); assert.equal(result.text, ""); assert.equal(h.reports, 1); assert.equal(h.session.isIdle, true);
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
  assert.equal(botToolAllowed("router", "bot_create_work"), true); assert.equal(botToolAllowed("router", "codemode"), false);
});

test("报告后 tool_call 被 sealed，且 context 注入当前会话状态", async (t) => {
  const h = await harness(t, [fauxAssistantMessage([fauxToolCall("bot_report", { outcome: "ready", summary: "已完成", evidence: [], artifacts: [] })], { stopReason: "toolUse" })], "worker", (pi) => {
    pi.registerTool({ name: "after_report", label: "after", description: "after", parameters: { type: "object", properties: {} } as never, execute: async () => ({ content: [{ type: "text", text: "bad" }] }) });
    pi.on("context", (event) => { assert.ok(event.messages.some((message) => message.role === "custom" && message.customType === "vivi-live-context")); });
  });
  await h.run(); assert.equal(h.reports, 1); assert.equal(h.session.isIdle, true);
});
