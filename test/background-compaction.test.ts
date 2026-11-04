import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AgentSession, createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, estimateTokens, sessionEntryToContextMessages,
  type CompactionResult,
} from "@earendil-works/pi-coding-agent";
import { createFauxCore, fauxAssistantMessage, InMemoryModelsStore, type FauxResponseFactory } from "@earendil-works/pi-ai";
import { BackgroundCompactions } from "../src/main/engine/background-compaction.ts";
import { installNativeCompactionGuard } from "../src/main/engine/native-compaction.ts";
import { mapEngineMessages } from "../src/main/engine/map-messages.ts";
import { transcriptWindow, transcriptEntryEnd } from "../src/main/engine/transcript-window.ts";

// Use the production projection with the same Electron-free adapter as transcript paging tests.
const require = createRequire(import.meta.url);
const ts = require("typescript") as typeof import("typescript");
const projectionSource = readFileSync(new URL("../src/main/pi/process-manager-transcript.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(projectionSource, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const projectionModule = { exports: {} };
const dependencies: Record<string, unknown> = {
  "@earendil-works/pi-coding-agent": { sessionEntryToContextMessages },
  "../engine/map-messages": { mapEngineMessages },
  "./tui-bridge": { renderExtensionMessage: () => undefined },
  "./process-manager-events": { isRecord: (value: unknown) => typeof value === "object" && value !== null },
  "../engine/transcript-window": { transcriptWindow, transcriptEntryEnd },
  "../engine/tool-images": { externalizeToolResultMessages: <T>(messages: T[]) => messages },
};
runInNewContext(compiled, { module: projectionModule, exports: projectionModule.exports, Date, Map, require: (name: string) => {
  assert.ok(name in dependencies, name); return dependencies[name];
} });
const { projectSessionMessages } = projectionModule.exports as typeof import("../src/main/pi/process-manager-transcript.ts");
function transcript(session: AgentSession) {
  return projectSessionMessages({ session, conversationId: "chat", reasoning: { get: () => undefined },
    widgetWidth: 80, running: new Map(), compacting: new Map() }).messages;
}

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
async function until(check: () => boolean) {
  const deadline = Date.now() + 4000;
  while (!check()) {
    assert.ok(Date.now() < deadline, "condition timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
async function harness(options: { fail?: boolean; emptyTail?: boolean; separateSummaryGates?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "background-compaction-"));
  const summaryStarted = gate(), summaryRelease = gate(), secondSummaryStarted = gate(), secondSummaryRelease = gate(), promptStarted = gate(), promptRelease = gate();
  let holdPrompt = false;
  let summaries = 0;
  const models = [{ id: "test", name: "test", contextWindow: 200_000, maxTokens: 4096,
    reasoning: false, input: ["text"] as ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }];
  const faux = createFauxCore({ api: "faux-background", provider: "faux", models, tokenSize: { min: 1024, max: 1024 } });
  const respond: FauxResponseFactory = async (context) => {
    if (JSON.stringify(context.messages).includes("You are a context summarization assistant")) {
      const attempt = ++summaries;
      (attempt === 1 ? summaryStarted : secondSummaryStarted).resolve();
      await (attempt === 1 || !options.separateSummaryGates ? summaryRelease : secondSummaryRelease).promise;
      if (options.fail) return fauxAssistantMessage("", { stopReason: "error", errorMessage: "401 invalid API key" });
      return fauxAssistantMessage("## Goal\nKeep working.\n## Progress\nEarlier tasks completed.");
    }
    promptStarted.resolve();
    if (holdPrompt) await promptRelease.promise;
    return fauxAssistantMessage("new answer");
  };
  faux.setResponses(Array.from({ length: 100 }, () => respond));
  const runtime = await ModelRuntime.create({ credentials: undefined, authPath: join(dir, "auth.json"), modelsPath: null,
    modelsStore: new InMemoryModelsStore(), allowModelNetwork: false, refreshOnCreate: false });
  runtime.registerProvider("faux", { api: "faux-background", baseUrl: "http://faux.invalid", apiKey: "unused", streamSimple: faux.streamSimple, models });
  const sm = SessionManager.inMemory(dir);
  for (let i = 0; i < 30; i++) {
    sm.appendMessage({ role: "user", content: `old task ${i} ${"x".repeat(5000)}`, timestamp: i * 2 });
    sm.appendMessage({ ...fauxAssistantMessage(`old answer ${i}`), provider: "faux", model: "test", timestamp: i * 2 + 1 });
  }
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false, ...(options.emptyTail ? { keepRecentTokens: 0 } : {}) }, retry: { enabled: false } });
  const resourceLoader = new DefaultResourceLoader({ cwd: dir, agentDir: dir, settingsManager,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noContextFiles: true, systemPrompt: "test system" });
  await resourceLoader.reload();
  const { session } = await createAgentSession({ cwd: dir, agentDir: dir, modelRuntime: runtime,
    model: runtime.getModel("faux", "test"), tools: [], sessionManager: sm, settingsManager, resourceLoader });
  installNativeCompactionGuard(session);
  const sourceEvents: string[] = [];
  session.subscribe((event) => sourceEvents.push(event.type));
  const applied: CompactionResult[] = [], errors: unknown[] = [];
  let current = true;
  const background = new BackgroundCompactions({ runtime, agentDir: dir,
    isCurrent: (id, source) => current && id === "chat" && source === session,
    onApplied: (_id, result) => applied.push(result), onError: (_id, error) => errors.push(error) });
  return { session, sm, background, applied, errors, sourceEvents, summaryStarted, summaryRelease, promptStarted, promptRelease,
    holdPrompt: () => { holdPrompt = true; }, replace: () => { current = false; }, summaries: () => summaries,
    secondSummaryStarted, secondSummaryRelease,
    close: async () => {
      background.clear(); summaryRelease.resolve(); secondSummaryRelease.resolve(); promptRelease.resolve();
      await new Promise((resolve) => setTimeout(resolve, 20));
      session.dispose(); rmSync(dir, { recursive: true, force: true });
    } };
}

test("a live prompt completes while snapshot summary is gated; new messages survive one idle apply", async () => {
  const h = await harness();
  try {
    const originalReserve = h.session.settingsManager.getCompactionReserveTokens;
    h.background.schedule("chat", h.session);
    h.background.schedule("chat", h.session);
    assert.equal(h.background.has("chat"), true);
    await h.summaryStarted.promise;
    assert.equal(transcript(h.session).filter((row) => row.kind === "compact").length, 0);
    assert.ok(!h.sourceEvents.includes("compaction_start"));
    assert.equal(h.session.settingsManager.getCompactionReserveTokens, originalReserve, "snapshot guard cannot wrap live settings");
    assert.equal(h.session.isIdle, true);
    const prompt = h.session.prompt("brand new prompt");
    await Promise.race([prompt, new Promise((_, reject) => setTimeout(() => reject(new Error("prompt blocked by summary")), 1000).unref())]);
    const newMessages = h.sm.getBranch().slice(-2);
    h.summaryRelease.resolve();
    await until(() => h.applied.length === 1);
    assert.equal(h.background.has("chat"), false);
    assert.equal(h.background.apply("chat"), false);
    assert.equal(h.summaries(), 1);
    for (const entry of newMessages) assert.ok(h.sm.buildSessionProjection().entries.some((item) => item.sourceEntry.id === entry.id));
    assert.ok(JSON.stringify(h.session.messages).includes("brand new prompt"));
    assert.ok(JSON.stringify(h.session.messages).includes("new answer"));
    assert.ok(!h.sourceEvents.includes("compaction_start"));
    const dividers = transcript(h.session).filter((row) => row.kind === "compact");
    assert.equal(dividers.length, 1);
    assert.equal(dividers[0].compact?.status, "done");
    assert.deepEqual(transcript(h.session).filter((row) => row.kind === "compact"), dividers);
    const after = h.sm.buildSessionProjection().messages.reduce((sum, message) => sum + estimateTokens(message), 0);
    assert.equal((h.applied[0].details as { tokensAfter: number }).tokensAfter, after);
    assert.deepEqual(h.errors, []);
  } finally { await h.close(); }
});

test("a completed summary waits while the source is running, then applies synchronously at idle", async () => {
  const h = await harness();
  try {
    h.background.schedule("chat", h.session);
    await h.summaryStarted.promise;
    h.holdPrompt();
    const prompt = h.session.prompt("hold this answer");
    await h.promptStarted.promise;
    const before = structuredClone(h.sm.getBranch());
    h.summaryRelease.resolve();
    // Wait for summary completion without relying on a source event: source emits none.
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(h.background.apply("chat"), false);
    assert.deepEqual(h.sm.getBranch(), before);
    assert.equal(h.applied.length, 0);
    assert.equal(h.background.has("chat"), true);
    h.promptRelease.resolve(); await prompt;
    assert.equal(h.background.apply("chat"), true);
    assert.equal(h.applied.length, 1);
  } finally { await h.close(); }
});

for (const mutation of ["branch", "context edit", "compaction", "model", "thinking", "replacement"] as const) {
  test(`stale summary is discarded after ${mutation}`, async () => {
    const h = await harness();
    try {
      h.background.schedule("chat", h.session); await h.summaryStarted.promise;
      const branch = h.sm.getBranch();
      if (mutation === "branch") h.sm.branch(branch[10].id);
      if (mutation === "context edit") h.sm.appendContextEdit(branch[0].id, { content: "edited" });
      if (mutation === "compaction") h.sm.appendCompaction("new checkpoint", branch[40].id, 40000);
      if (mutation === "model") h.session.agent.state.model = { ...h.session.model!, baseUrl: "http://changed.invalid" };
      if (mutation === "thinking") h.session.agent.state.thinkingLevel = "high";
      if (mutation === "replacement") h.replace();
      const before = structuredClone(h.sm.getBranch());
      h.summaryRelease.resolve(); await until(() => !h.background.has("chat"));
      assert.deepEqual(h.sm.getBranch(), before);
      assert.equal(h.applied.length, 0);
      assert.deepEqual(h.errors, []);
    } finally { await h.close(); }
  });
}

test("cancel, immediate reschedule and clear fence late summary completion without source events", async () => {
  const h = await harness();
  try {
    h.background.schedule("chat", h.session); await h.summaryStarted.promise;
    const before = structuredClone(h.sm.getBranch());
    h.background.cancel("chat"); assert.equal(h.background.has("chat"), false);
    h.background.schedule("chat", h.session);
    h.background.clear();
    h.summaryRelease.resolve();
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.deepEqual(h.sm.getBranch(), before);
    assert.deepEqual(h.sourceEvents, []);
    assert.deepEqual(h.applied, []); assert.deepEqual(h.errors, []);
    assert.equal(h.background.has("chat"), false);
  } finally { await h.close(); }
});

test("cancel then reschedule keeps the new task when the cancelled provider finishes late", async () => {
  const h = await harness({ separateSummaryGates: true });
  try {
    h.background.schedule("chat", h.session); await h.summaryStarted.promise;
    h.background.cancel("chat");
    h.background.schedule("chat", h.session); await h.secondSummaryStarted.promise;
    h.summaryRelease.resolve();
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(h.background.has("chat"), true);
    assert.deepEqual(h.applied, []);
    assert.deepEqual(h.errors, []);
    h.secondSummaryRelease.resolve();
    await until(() => !h.background.has("chat"));
    assert.equal(h.applied.length, 1);
    assert.equal(h.sm.getBranch().filter((entry) => entry.type === "compaction").length, 1);
    assert.deepEqual(h.sourceEvents, []);
  } finally { await h.close(); }
});

test("schedule refuses busy or replaced sources before starting snapshot work", async () => {
  const h = await harness();
  try {
    h.holdPrompt();
    const prompt = h.session.prompt("busy source"); await h.promptStarted.promise;
    h.background.schedule("chat", h.session);
    assert.equal(h.background.has("chat"), false);
    h.promptRelease.resolve(); await prompt;
    h.replace(); h.background.schedule("chat", h.session);
    assert.equal(h.background.has("chat"), false);
    assert.equal(h.summaries(), 0);
  } finally { await h.close(); }
});

test("summary failure only reaches the logger and clears has", async () => {
  const h = await harness({ fail: true });
  try {
    const before = structuredClone(h.sm.getBranch());
    h.background.schedule("chat", h.session); await h.summaryStarted.promise;
    h.summaryRelease.resolve(); await until(() => !h.background.has("chat"));
    assert.equal(h.errors.length, 1);
    assert.deepEqual(h.sm.getBranch(), before);
    assert.deepEqual(h.applied, []); assert.deepEqual(h.sourceEvents, []);
  } finally { await h.close(); }
});

test("fully summarized snapshot retains messages appended after its empty retention boundary", async (t) => {
  const nativeCompact = AgentSession.prototype.compact;
  // Pi's current normal cut keeps at least one message. Simulate its allowed empty
  // result at the public API boundary, after running the real summary request.
  t.mock.method(AgentSession.prototype, "compact", async function (this: AgentSession, instructions?: string) {
    return { ...await nativeCompact.call(this, instructions), firstKeptEntryId: "" };
  });
  const h = await harness({ emptyTail: true });
  try {
    h.background.schedule("chat", h.session); await h.summaryStarted.promise;
    const firstNewId = h.sm.appendCustomMessageEntry("memory-test", "new hidden memory", false);
    h.sm.appendCustomMessageEntry("goal-test", "new goal context", false);
    h.session.refreshContext();
    await h.session.prompt("new message outside snapshot");
    h.summaryRelease.resolve();
    await until(() => !h.background.has("chat"));
    assert.equal(h.applied.length, 1);
    assert.equal(h.applied[0].firstKeptEntryId, firstNewId);
    assert.ok(JSON.stringify(h.session.messages).includes("new hidden memory"));
    assert.ok(JSON.stringify(h.session.messages).includes("new goal context"));
    assert.ok(JSON.stringify(h.session.messages).includes("new message outside snapshot"));
  } finally { await h.close(); }
});
