import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import { resolveReviewModel } from "../src/main/pi/review-model.ts";
import { SubagentControl } from "../src/main/pi/subagent-control.ts";
import { ToolDeltaThrottle } from "../src/main/pi/tool-delta-throttle.ts";
import { AgentThreadStore } from "../src/main/engine/agent-thread-store.ts";
import { openTestDb, testDir } from "./test-db.ts";
import type { ReviewReport } from "../src/shared/review.ts";

const report: ReviewReport = { version: 1, summary: "No confirmed defects", findings: [], coverage: { reviewedPaths: ["file.ts"], unreviewedPaths: [] } };
const model = { provider: "review-provider", id: "chosen/model" };

test("Review requires its own authenticated model and never inherits the chat model", () => {
  const registry = {
    find: (provider: string, id: string) => provider === model.provider && id === model.id ? model : undefined,
    hasConfiguredAuth: () => true,
    getAvailable: () => [{ provider: "chat", id: "fallback" }],
  } as any;
  assert.throws(() => resolveReviewModel(registry), /Review/);
  assert.throws(() => resolveReviewModel(registry, "missing/model"), /Review/);
  assert.equal(resolveReviewModel(registry, "review-provider/chosen/model"), model);
  registry.hasConfiguredAuth = () => false;
  assert.throws(() => resolveReviewModel(registry, "review-provider/chosen/model"), /Review/);
});

const ts = createRequire(import.meta.url)("typescript") as typeof import("typescript");
const file = ts.createSourceFile("runner.ts", readFileSync(new URL("../src/main/pi/process-manager-subagent.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
let method = "";
const visit = (node: import("typescript").Node): void => {
  if (ts.isMethodDeclaration(node) && node.name.getText(file) === "#runSubagent") method = node.getText(file).replaceAll("#", "");
  ts.forEachChild(node, visit);
};
visit(file);
assert.ok(method);
const compiled = ts.transpileModule(`class Harness { ${method} }`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;

function runner(options: { submit?: boolean; abortAfterSubmit?: boolean } = {}) {
  let result: ReviewReport | undefined;
  let prompts = 0;
  let created: any;
  let loaderOptions: any;
  let imageFactories = 0;
  const events: any[] = [];
  let host: any;
  const session = {
    messages: [] as any[], model, thinkingLevel: "high",
    bindExtensions: async () => {}, subscribe: () => () => {}, dispose() {}, abort: async () => {},
    prompt: async () => {
      prompts++;
      if (options.submit !== false) result = report;
      session.messages.push({ role: "assistant", content: [] });
      if (options.abortAfterSubmit) await host.subagentControls.get("review-run").abort();
    },
  };
  const deps = {
    SubagentControl, builtinExtensionFile: () => null,
    SettingsManager: { create: () => ({}) },
    currentAiLanguageDirective: () => "", currentCustomSystemPrompt: () => "",
    DefaultResourceLoader: class {
      constructor(settings: any) { loaderOptions = settings; }
      async reload() {}
      getExtensions() { return { extensions: [] }; }
    },
    createReviewTools: () => ({ factory: () => {}, getReport: () => result }),
    readDefaultModel: () => ({ provider: "chat", id: "fallback" }),
    availableImageTools: (tools: string[]) => tools,
    SessionManager: { inMemory: () => ({}) },
    createAgentSession: async (settings: any) => { created = settings; return { session }; },
    summarizeSubagentMessages: () => ({ stopReason: "stop", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, turns: 1 } }),
    sessionEntryIds: () => new Map(), sessionCompletionTimes: () => new Map(), mapEngineMessages: () => [],
    guardSessionListener: (_owner: string, listener: unknown) => listener,
    slimStreamEvent: (event: unknown) => event,
    isAbortOutcome: (error: Error) => error.name === "AbortError", uiText: (_zh: string, en: string) => en,
  };
  const Harness = new Function(...Object.keys(deps), `${compiled}; return Harness;`)(...Object.values(deps));
  host = new Harness();
  Object.assign(host, {
    runtime: {}, models: {}, paths: { agentDir: "/tmp" }, cwd: "/repo",
    subagentManager: { modelFor: () => "changed/setting", thinkingLevelFor: () => "low" },
    resolveSubagentModel: () => { throw new Error("Review must not resolve a fallback"); },
    subagentControls: new Map(), subagentSessions: new Map(), subagentMessages: new Map(), subagentReasoning: new Map(), reasoningRun: new Map(), stoppedSubagents: new Set(),
    toolDeltas: new ToolDeltaThrottle(),
    extensionUi: () => ({}), resolvePendingUi() {}, publishSubagentState() {}, timeReasoning() {}, fileSubagentReasoning() {}, withThinkingTiming() {},
    imageGeneration: () => { imageFactories++; return () => {}; },
    emit: (event: any) => events.push(event),
  });
  host.host = host;
  return {
    run: () => host.runSubagent("conversation", { subagentId: "review-run", agent: "review", task: "review snapshot", systemPrompt: "Review only", cwd: "/repo", reviewSnapshot: {}, pinnedModel: model, thinkingLevel: "high" }),
    get created() { return created; }, get loaderOptions() { return loaderOptions; }, get prompts() { return prompts; }, get imageFactories() { return imageFactories; }, events,
  };
}

test("Review runner pins the model and reasoning, exposes only snapshot tools, and returns the structured report", async () => {
  const f = runner();
  const result = await f.run();
  assert.equal(result.exitCode, 0);
  assert.equal(result.reviewReport, report);
  assert.equal(f.created.model, model);
  assert.equal(f.created.thinkingLevel, "high");
  assert.deepEqual(f.created.tools, ["review_read_file", "review_search", "submit_review_result"]);
  assert.deepEqual(f.loaderOptions.extensionFactories.map((item: any) => item.name), ["fastvibe-review"]);
  assert.equal(f.imageFactories, 0);
  assert.equal(f.prompts, 1);
});

test("plain text completion cannot become a successful Review report", async () => {
  const f = runner({ submit: false });
  const result = await f.run();
  assert.equal(result.exitCode, 1);
  assert.equal(result.reviewReport, undefined);
  assert.match(result.errorMessage, /structured report/);
  assert.equal(f.prompts, 2, "only one structured-result repair is attempted");
});

test("a cancelled Review never publishes a submitted report as successful", async () => {
  const f = runner({ abortAfterSubmit: true });
  const result = await f.run();
  assert.equal(result.stopReason, "aborted");
  assert.equal(result.reviewReport, undefined);
  assert.equal(f.events.at(-1).status, "aborted");
});

test("structured reports survive a new store instance and remain owned by their conversation", (t) => {
  const db = openTestDb(testDir("review-persistence-"));
  t.after(() => db.close());
  const store = new AgentThreadStore(db);
  store.create({ id: "agent-review", conversationId: "a", agent: "review", task: "Review", cwd: "/repo", status: "working", currentTurn: 1 });
  store.finishTurn("agent-review", 1, "completed", report.summary, undefined, report);
  const restored = new AgentThreadStore(db);
  assert.deepEqual(restored.get("agent-review")?.reviewReport, report);
  assert.deepEqual(restored.messages("agent-review")[0].reviewReport, report);
  assert.equal(restored.pendingResults("b").length, 0);
  assert.equal(restored.pendingResults("a").length, 1);
  assert.equal(restored.finishTurn("agent-review", 1, "completed", "duplicate", undefined, { ...report, summary: "wrong" }), undefined);
  assert.equal(restored.get("agent-review")?.reviewReport?.summary, report.summary);
});
