import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { createFauxCore, fauxAssistantMessage, fauxToolCall, InMemoryModelsStore } from "@earendil-works/pi-ai";
import { botSessionExtension, type BotSessionService } from "../src/main/bot/bot-session-extension.ts";
import { runBotSession } from "../src/main/bot/bot-engine-host.ts";
import type { BotContext, BotProgressRequest, BotReportRequest } from "../src/shared/bot.ts";

test("真实 SDK 阶段进度不结束工作，最终报告绑定本轮输入而非工具调用 id", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "vivi-progress-sdk-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const faux = createFauxCore({ api: "faux-api", provider: "faux", models: [{ id: "scripted" }] });
  let request = { requestId: "input-1", epoch: 4 };
  const progress: BotProgressRequest[] = [];
  const reports: BotReportRequest[] = [];
  const seenContexts: string[] = [];
  faux.setResponses([
    (context) => {
      seenContexts.push(JSON.stringify(context.messages));
      request = { requestId: "later-queued-input", epoch: 5 };
      return fauxAssistantMessage([fauxToolCall("bot_progress", { phase: "working", text: "已经整理好发布记录，接下来检查链接。", milestone: true })], { stopReason: "toolUse" });
    },
    fauxAssistantMessage([fauxToolCall("bot_report", { outcome: "ready", summary: "文档和链接已检查。", evidence: ["链接检查通过"], artifacts: ["/output/release.md"] })], { stopReason: "toolUse" }),
    fauxAssistantMessage([fauxToolCall("bot_progress", { phase: "planning", text: "先确认本轮补充要求。" })], { stopReason: "toolUse" }),
    fauxAssistantMessage([fauxToolCall("bot_report", { outcome: "blocked", summary: "需要确认文档受众。" })], { stopReason: "toolUse" }),
  ]);
  const runtime = await ModelRuntime.create({ authPath: join(dir, "auth.json"), modelsPath: null, modelsStore: new InMemoryModelsStore(), allowModelNetwork: false, refreshOnCreate: false });
  runtime.registerProvider("faux", { baseUrl: "http://faux.invalid", api: "faux-api" as never, apiKey: "unused", streamSimple: faux.streamSimple as never, models: [{ id: "scripted", name: "scripted", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 4096 }] });
  const contextFor = (conversationId: string): BotContext => ({ role: "worker", conversationId, active: true, phase: "running", input: request, progress: [{ conversationId, inputId: "input-1", role: "worker", phase: "working", detail: "整理发布记录", startedAt: 1, updatedAt: 2, queuedCount: 0 }] });
  const service: BotSessionService = {
    contextFor,
    submit: async () => ({}), routeMessage: async () => ({}), reply: async () => ({}), createWork: async () => ({}), ask: async () => ({}),
    progress: async (input) => { progress.push(input); return { updated: true }; },
    report: async (input) => { reports.push(input); return { recorded: true }; },
    stopConversation: async () => ({}), continueConversation: async () => ({}),
  };
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
  const resourceLoader = new DefaultResourceLoader({ cwd: dir, agentDir: dir, settingsManager, noSkills: true, noContextFiles: true, noExtensions: true, extensionFactories: [{ name: "vivi", factory: botSessionExtension({ role: "worker", conversationId: "worker:1", service, projects: () => [] }) }] });
  await resourceLoader.reload();
  const { session } = await createAgentSession({ cwd: dir, agentDir: dir, modelRuntime: runtime, model: runtime.getModel("faux", "scripted"), sessionManager: SessionManager.inMemory(dir), settingsManager, resourceLoader });
  t.after(() => session.dispose());
  await session.bindExtensions({ mode: "rpc" });
  const run = () => runBotSession(session, "请继续", { signal: new AbortController().signal, timeoutMs: 5000, abort: () => session.abort() });
  assert.equal((await run()).status, "completed");
  assert.equal(progress.length, 1);
  assert.equal(progress[0].requestId, "input-1");
  assert.equal(progress[0].epoch, 4);
  assert.equal(progress[0].milestone, true);
  assert.equal(reports.length, 1);
  assert.equal(reports[0].requestId, "input-1");
  assert.equal(reports[0].epoch, 4);
  assert.deepEqual(reports[0].artifacts, ["/output/release.md"]);
  assert.match(seenContexts[0], /整理发布记录/);
  assert.equal((await run()).status, "completed");
  assert.equal(progress.length, 2, "新一轮必须重新开放进度工具");
  assert.equal(progress[1].requestId, "later-queued-input");
  assert.equal(reports[1].epoch, 5);
});
