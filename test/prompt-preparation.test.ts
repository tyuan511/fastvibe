import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Agent } from "@earendil-works/pi-agent-core";
import { AgentSession, DefaultResourceLoader, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { PromptPreparations } from "../src/main/pi/prompt-preparation.ts";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

test("Stop during a real SDK memory hook releases preparation and prevents the provider from starting", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "fastvibe-preflight-stop-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const preparations = new PromptPreparations();
  const entered = deferred();
  let requests = 0;
  let signal: AbortSignal | undefined;
  const partial = {
    role: "assistant" as const, content: [{ type: "text" as const, text: "ok" }], provider: "fake", model: "m", timestamp: Date.now(), stopReason: "stop" as const,
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  };
  const streamFn = () => {
    requests++;
    return { async *[Symbol.asyncIterator]() { yield { type: "start", partial }; yield { type: "done", reason: "stop", message: partial }; }, result: async () => partial };
  };
  const agent = new Agent({ initialState: {
    systemPrompt: "", model: { provider: "fake", id: "m", name: "F", contextWindow: 100_000, maxTokens: 4096, input: ["text"], api: "openai-completions" }, thinkingLevel: "off", tools: [],
  }, convertToLlm: (messages) => messages, streamFn } as never);
  const settingsManager = SettingsManager.create(dir, join(dir, "agent"));
  const sessionManager = SessionManager.create(dir, join(dir, "sessions"));
  let first = true;
  const resourceLoader = new DefaultResourceLoader({ cwd: dir, agentDir: join(dir, "agent"), settingsManager, extensionFactories: [{ name: "memory", factory: (pi) => {
    pi.on("before_agent_start", async () => {
      if (!first) return;
      first = false;
      signal = preparations.signal("chat");
      entered.resolve();
      await new Promise<void>((resolve) => signal!.addEventListener("abort", () => resolve(), { once: true }));
    });
  } }] });
  await resourceLoader.reload();
  const session = new AgentSession({ agent, sessionManager, settingsManager, cwd: dir, resourceLoader, initialActiveToolNames: [], modelRuntime: {
    hasConfiguredAuth: () => true, checkAuth: async () => ({}), isUsingOAuth: () => false, getAuth: async () => ({ auth: {} }), streamSimple: streamFn,
  } as never });
  await session.bindExtensions({ mode: "rpc", onError: (error) => assert.fail(error.error) });
  preparations.install("chat", session);
  const pending = session.prompt("first");
  await entered.promise;
  assert.ok(signal);
  preparations.cancel("chat");
  await session.abort();
  await assert.rejects(pending, { name: "AbortError" });
  assert.equal(requests, 0);
  assert.equal(session.messages.length, 0);
  // A stop belongs to that preparation, not to the next prompt in this chat.
  await session.prompt("second");
  assert.equal(requests, 1);
});

test("cancelling one chat leaves another preparation intact and engine cancellation stops all", async () => {
  const preparations = new PromptPreparations();
  const held = deferred();
  const signals = new Map<string, AbortSignal>();
  const session = (id: string) => ({ prompt: async (_text: string, options?: Parameters<AgentSession["prompt"]>[1]) => {
    signals.set(id, preparations.signal(id)!);
    await held.promise;
    options?.preflightResult?.("started");
  } });
  const a = session("a"), b = session("b");
  preparations.install("a", a); preparations.install("b", b);
  const pa = a.prompt("a"), pb = b.prompt("b");
  preparations.cancel("a");
  assert.equal(signals.get("a")!.aborted, true);
  assert.equal(signals.get("b")!.aborted, false);
  preparations.cancel();
  assert.equal(signals.get("b")!.aborted, true);
  held.resolve();
  await assert.rejects(pa, { name: "AbortError" });
  await assert.rejects(pb, { name: "AbortError" });
});

test("Main stops the selected chat's preparation before waiting for queue cleanup", async () => {
  const ts = createRequire(import.meta.url)("typescript") as typeof import("typescript");
  const source = readFileSync(new URL("../src/main/pi/process-manager.ts", import.meta.url), "utf8");
  const file = ts.createSourceFile("process-manager.ts", source, ts.ScriptTarget.Latest, true);
  let method = "";
  function visit(node: import("typescript").Node): void {
    if (ts.isMethodDeclaration(node) && node.name.getText(file) === "abort") method = node.getText(file);
    ts.forEachChild(node, visit);
  }
  visit(file); assert.ok(method);
  const compiled = ts.transpileModule(`class Harness { ${method.replaceAll("#", "")} }`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
  const Harness = new Function("uiText", `${compiled}; return Harness;`)((zh: string) => zh);
  const host = new Harness();
  const cleanup = deferred();
  const cancelled: Array<string | undefined> = [];
  Object.assign(host, {
    activeId: "active", promptPreparations: { cancel: (id?: string) => cancelled.push(id) }, dagScheduler: { cancel() {} },
    bumpQueueEpoch() {}, withQueue: async () => cleanup.promise, resolvePendingUi() {},
    sessionFor: async () => ({ session: { abort: async () => {} } }),
  });
  const stopped = host.abort("background");
  assert.deepEqual(cancelled, ["background"]);
  cleanup.resolve();
  await stopped;
});
