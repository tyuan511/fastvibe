import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import { SubagentControl } from "../src/main/pi/subagent-control.ts";
import { reduceSubagent } from "../src/shared/subagent-state.ts";

const ts = createRequire(import.meta.url)("typescript") as typeof import("typescript");
const source = readFileSync(new URL("../src/main/pi/process-manager.ts", import.meta.url), "utf8");
const file = ts.createSourceFile("manager.ts", source, ts.ScriptTarget.Latest, true);
let method = "";
function visit(node: import("typescript").Node): void {
  if (ts.isMethodDeclaration(node) && node.name.getText(file) === "#runSubagent") method = node.getText(file);
  ts.forEachChild(node, visit);
}
visit(file);
assert.ok(method);
// Exercise the real host runner with a fake SDK, no Electron, provider or agent calls.
const compiled = ts.transpileModule(`class Harness { ${method.replaceAll("#", "")} }`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText;

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function fixture(options: { setup?: () => Promise<void>; create?: () => Promise<void>; prompt?: () => Promise<void>; cacheFails?: boolean } = {}) {
  let prompts = 0;
  let disposed = 0;
  let unsubscribed = 0;
  const release = deferred();
  const phases: any[] = [];
  const cleared: string[] = [];
  const session = {
    messages: [{ role: "assistant", content: [] }], model: { provider: "fake", id: "m" },
    bindExtensions: async () => {},
    subscribe: () => () => { unsubscribed++; },
    prompt: async () => { prompts++; await options.prompt?.(); },
    abort: async () => { release.resolve(); },
    dispose: () => { disposed++; },
  };
  const deps = {
    SubagentControl,
    SettingsManager: { create: () => ({}) },
    builtinExtensionFile: () => undefined,
    currentAiLanguageDirective: () => "", currentCustomSystemPrompt: () => "",
    DefaultResourceLoader: class { reload() { return options.setup?.() ?? Promise.resolve(); } },
    readDefaultModel: () => undefined,
    createAgentSession: async () => { await options.create?.(); return { session }; },
    SessionManager: { inMemory: () => ({}) },
    summarizeSubagentMessages: () => ({ usage: {}, stopReason: "stop" }),
    sessionEntryIds: () => new Map(), sessionCompletionTimes: () => new Map(),
    mapEngineMessages: (messages: unknown) => { if (options.cacheFails) throw new Error("cache failed"); return messages; },
    isAbortOutcome: (error: Error) => error.name === "AbortError", uiText: (zh: string) => zh,
    slimStreamEvent: (e: unknown) => e,
  };
  const Harness = new Function(...Object.keys(deps), `${compiled}; return Harness;`)(...Object.values(deps));
  const host = new Harness();
  Object.assign(host, {
    runtime: {}, models: {}, cwd: "/fake", paths: { agentDir: "/fake" },
    subagentManager: { modelFor: () => undefined, thinkingLevelFor: () => "high" },
    resolveSubagentModel: () => session.model,
    subagentControls: new Map(), subagentSessions: new Map(), subagentMessages: new Map(),
    subagentReasoning: new Map(), reasoningRun: new Map(), stoppedSubagents: new Set(),
    extensionUi: () => ({}),
    resolvePendingUi: (_: unknown, owner: string) => { cleared.push(owner); },
    publishSubagentState: (subagentId: string, conversationId: string) => host.emit({ type: "subagent_state", subagentId, conversationId, model: session.model, thinkingLevel: "high" }),
    emit: (event: any) => {
      event.seq = phases.length + 1;
      host.info = reduceSubagent(host.info, event);
      if (event.type === "subagent_lifecycle" && event.status === "completed") assert.ok(host.subagentMessages.has("call:0"), "cache must precede terminal event");
      phases.push(event);
    },
  });
  return {
    host, phases, cleared, release,
    get prompts() { return prompts; }, get disposed() { return disposed; }, get unsubscribed() { return unsubscribed; },
    run: (signal?: AbortSignal) => host.runSubagent("parent", { subagentId: "call:0", agent: "fake", task: "test", systemPrompt: "", signal }),
  };
}

test("normal completion caches first, retains model/thinking and releases the runner", async () => {
  const f = fixture();
  const result = await f.run();
  assert.equal(result.exitCode, 0);
  assert.equal(f.host.info.status, "completed");
  assert.equal(f.host.info.thinkingLevel, "high");
  assert.equal(f.host.info.model.id, "m");
  assert.equal(f.host.info.conversationId, "parent");
  assert.equal(f.disposed, 1);
  assert.equal(f.unsubscribed, 1);
  assert.equal(f.host.subagentControls.size, 0);
  assert.equal(f.host.subagentSessions.size, 0);
});

test("setup failure still emits an owned terminal lifecycle and returns failure to parent", async () => {
  const f = fixture({ setup: async () => { throw new Error("setup failed"); } });
  const result = await f.run();
  assert.equal(result.exitCode, 1);
  assert.equal(result.errorMessage, "setup failed");
  assert.equal(f.host.info.status, "error");
  assert.equal(f.host.info.conversationId, "parent");
  assert.equal(f.host.subagentControls.size, 0);
});

test("already cancelled parent never starts a fresh prompt that resets abort", async () => {
  const parent = new AbortController(); parent.abort();
  const f = fixture();
  const result = await f.run(parent.signal);
  assert.equal(result.stopReason, "aborted");
  assert.equal(f.prompts, 0);
  assert.equal(f.host.info.status, "aborted");
});

test("cancellation during session creation cannot escape into prompt", async () => {
  const gate = deferred();
  const f = fixture({ create: () => gate.promise });
  const pending = f.run();
  await new Promise((resolve) => setImmediate(resolve));
  await f.host.subagentControls.get("call:0").abort();
  gate.resolve();
  assert.equal((await pending).stopReason, "aborted");
  assert.equal(f.prompts, 0);
  assert.equal(f.disposed, 1);
});

test("parent cancellation releases only this run's parked prompts and settles the tool", async () => {
  const parent = new AbortController();
  const f = fixture({ prompt: () => f.release.promise });
  const pending = f.run(parent.signal);
  await new Promise((resolve) => setImmediate(resolve));
  parent.abort();
  assert.equal((await pending).stopReason, "aborted");
  assert.ok(f.cleared.length > 0);
  assert.ok(f.cleared.every((id) => id === "call:0"));
  assert.equal(f.host.subagentControls.size, 0);
});

test("stopping one run returns an explicit aborted result while preserving its model", async () => {
  const f = fixture({ prompt: () => f.release.promise });
  const pending = f.run();
  await new Promise((resolve) => setImmediate(resolve));
  f.host.stoppedSubagents.add("call:0");
  await f.host.subagentControls.get("call:0").abort();
  const result = await pending;
  assert.equal(result.exitCode, 1);
  assert.equal(result.stopReason, "aborted");
  assert.equal(result.errorMessage, "已被用户终止");
  assert.equal(f.host.info.status, "aborted");
  assert.equal(f.host.info.thinkingLevel, "high");
  assert.equal(f.host.info.model.id, "m");
});

test("settled runs detach the parent's abort listener", async () => {
  const parent = new AbortController();
  const f = fixture();
  await f.run(parent.signal);
  const before = f.cleared.length;
  parent.abort();
  assert.equal(f.cleared.length, before);
});

test("prompt rejection is reported to the parent and never leaves a running tab", async () => {
  const f = fixture({ prompt: async () => { throw new Error("stream failed"); } });
  const result = await f.run();
  assert.equal(result.exitCode, 1);
  assert.equal(f.host.info.status, "error");
  assert.equal(f.host.info.error, "stream failed");
  assert.equal(f.disposed, 1);
});

test("transcript mapping failure cannot strand the run or leave a waiting parent", async () => {
  const f = fixture({ cacheFails: true });
  assert.equal((await f.run()).exitCode, 1);
  assert.equal(f.host.info.status, "error");
  assert.equal(f.disposed, 1);
  assert.equal(f.host.subagentControls.size, 0);
  assert.equal(f.host.subagentSessions.size, 0);
});
