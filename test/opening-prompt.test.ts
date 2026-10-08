import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Agent } from "@earendil-works/pi-agent-core";
import { AgentSession, DefaultResourceLoader, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { sendOpeningPrompt } from "../src/main/pi/opening-prompt.ts";
import { mapEngineMessages } from "../src/main/engine/map-messages.ts";
import * as attachmentMetadata from "../src/shared/attachment-metadata.ts";
import * as toolResult from "../src/shared/tool-result.ts";
import type { ChatMessage, EngineEvent } from "../src/shared/types.ts";

const ts = createRequire(import.meta.url)("typescript") as typeof import("typescript");
const source = readFileSync(new URL("../src/main/pi/process-manager.ts", import.meta.url), "utf8");
const file = ts.createSourceFile("process-manager.ts", source, ts.ScriptTarget.Latest, true);
const methods: string[] = [];
const wanted = new Set(["#replacementContext", "#messagesFrom", "#holdCommand", "getSnapshot"]);
function visit(node: import("typescript").Node): void {
  if (ts.isMethodDeclaration(node) && wanted.has(node.name.getText(file))) methods.push(node.getText(file));
  ts.forEachChild(node, visit);
}
visit(file);
assert.equal(methods.length, wanted.size);
const compiled = ts.transpileModule(`class Harness { ${methods.join("\n").replaceAll("#", "")} }`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText;
// Execute the actual host methods without loading Electron, as other engine tests do.
const Harness = new Function("sendOpeningPrompt", "randomUUID", "uiText", "projectSessionMessages", `${compiled}; return Harness;`)(
  sendOpeningPrompt, randomUUID, (zh: string) => zh,
  ({ session }: { session: AgentSession }) => {
    const entries = session.sessionManager.getBranch().filter((entry) => entry.type === "message");
    return { messages: mapEngineMessages(entries.map((entry) => entry.message), (message) => entries.find((entry) => entry.message === message)?.id), anchored: true };
  },
);

// Run the real renderer reducer without React, DOM, or browser automation.
const rendererSource = readFileSync(new URL("../src/renderer/src/lib/apply-engine-event.ts", import.meta.url), "utf8");
const renderer = ts.transpileModule(rendererSource, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;
const exports: { applyEngineEvent?: (messages: ChatMessage[], event: EngineEvent, streaming: boolean) => { messages: ChatMessage[]; streaming: boolean } } = {};
new Function("require", "exports", renderer)((name: string) => {
  if (name === "@shared/attachment-metadata") return attachmentMetadata;
  if (name === "@shared/tool-result") return toolResult;
  if (name.endsWith("random.ts")) return { randomUUID };
  if (name === "@/lib/i18n") return { i18n: { t: (key: string) => key } };
  throw new Error(`Unexpected dependency: ${name}`);
}, exports);
const apply = exports.applyEngineEvent!;

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function fixture(t: Parameters<Parameters<typeof test>[1]>[0], options: { reject?: boolean; handled?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "fastvibe-opening-"));
  const memory = deferred();
  const enteredMemory = deferred();
  const reply = deferred();
  const started = deferred();
  const partial = {
    role: "assistant" as const, content: [{ type: "text" as const, text: "ok" }], provider: "fake", model: "m",
    timestamp: Date.now(), stopReason: "stop" as const,
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  };
  const streamFn = () => ({
    async *[Symbol.asyncIterator]() {
      started.resolve();
      yield { type: "start", partial };
      await reply.promise;
      yield { type: "done", reason: "stop", message: partial };
    },
    result: async () => { await reply.promise; return partial; },
  });
  const model = { provider: "fake", id: "m", name: "F", contextWindow: 100_000, maxTokens: 4096, input: ["text"], api: "openai-completions" };
  const agent = new Agent({ initialState: { systemPrompt: "", model, thinkingLevel: "off", tools: [] }, convertToLlm: (messages) => messages, streamFn } as never);
  const settingsManager = SettingsManager.create(dir, join(dir, "agent"));
  const sessionManager = SessionManager.create(dir, join(dir, "sessions"));
  const resourceLoader = new DefaultResourceLoader({
    cwd: dir, agentDir: join(dir, "agent"), settingsManager,
    extensionFactories: [{ name: "slow-memory", factory: (pi) => {
      if (options.handled) pi.on("input", () => ({ action: "handled" }));
      pi.on("before_agent_start", async () => { enteredMemory.resolve(); await memory.promise; });
    } }],
  });
  await resourceLoader.reload();
  const session = new AgentSession({
    agent, sessionManager, settingsManager, cwd: dir, resourceLoader, initialActiveToolNames: [],
    modelRuntime: {
      hasConfiguredAuth: () => !options.reject, checkAuth: async () => options.reject ? undefined : ({}),
      isUsingOAuth: () => false, getAuth: async () => ({ auth: {} }), streamSimple: streamFn,
    } as never,
  });
  const host = new Harness();
  let messages: ChatMessage[] = [];
  let streaming = false;
  const statuses: Record<string, string> = {};
  const restored: string[] = [];
  const events: EngineEvent[] = [];
  Object.assign(host, {
    openingPrompts: new Map(), commandsInFlight: new Set(), pendingUi: new Map(), turnEvents: new Map(), eventSeq: 0,
    running: new Map(), compacting: new Map(), reasoning: { get: () => undefined }, widgetWidth: 80,
    busy: () => false, sessionFor: async () => ({ id: "next", session }),
    extensionStatusSnapshot: () => ({ ...statuses }),
    messageQueue: { state: () => ({ conversationId: "next", revision: 0, items: [], pause: null }) },
    adoptPromptPreview: (_id: string, text: string) => { host.preview = text; },
    emit: (event: EngineEvent) => {
      events.push(event);
      ({ messages, streaming } = apply(messages, event, streaming));
    },
  });
  await session.bindExtensions({
    mode: "rpc", onError: (error) => { throw new Error(error.error); },
    uiContext: {
      setStatus: (key: string, text?: string) => { if (text) statuses[key] = text; else delete statuses[key]; },
      setEditorText: (text: string) => restored.push(text),
    } as never,
  });
  session.subscribe((event) => {
    host.emit(event);
    if (event.type === "message_end" && event.message.role === "user") {
      queueMicrotask(() => {
        const entry = sessionManager.getBranch().find((entry) => entry.type === "message" && entry.message === event.message);
        host.emit({ type: "user_message_persisted", entryId: entry!.id });
      });
    }
  });
  t.after(async () => { memory.resolve(); reply.resolve(); await session.dispose(); rmSync(dir, { recursive: true, force: true }); });
  return {
    host, session, memory, enteredMemory, reply, started, statuses, restored, events,
    context: host.replacementContext({ conversationId: "next", session }),
    get messages() { return messages; },
  };
}

test("handoff displays its prompt and preparation state before memory completes, including on reopen", async (t) => {
  const f = await fixture(t);
  const text = "## Context\n已有结论\n## Task\n接着做";
  const sent = f.context.sendUserMessage(text);
  // No wait: the row is published synchronously by the host.
  assert.equal(f.messages[0]?.text, text);
  assert.match(f.statuses.handoff, /准备/);
  assert.equal(f.host.preview, text);
  await f.enteredMemory.promise;
  assert.equal(f.session.messages.some((message) => message.role === "user"), false);
  const snapshot = await f.host.getSnapshot("next");
  assert.equal(snapshot.messages[0].id, f.messages[0].id);
  assert.equal(snapshot.running, false, "preparing is not an SDK run or a stoppable stream");
  assert.equal(snapshot.turnEvents[0].statusText, f.statuses.handoff);
  assert.throws(() => f.host.holdCommand("next", "duplicate"), /准备/);
  await assert.rejects(f.context.sendUserMessage("duplicate"), /准备/);

  f.memory.resolve();
  await f.started.promise;
  assert.equal(f.statuses.handoff, undefined, "unlock before the answer has finished");
  assert.equal(f.host.openingPrompts.size, 0);
  assert.equal(f.messages.filter((message) => message.role === "user").length, 1, "SDK echo must not duplicate the submitted row");
  const persisted = f.session.sessionManager.getBranch().find((entry) => entry.type === "message" && entry.message.role === "user")!;
  assert.equal(f.messages.find((message) => message.role === "user")!.id, persisted.id);
  const ready = await f.host.getSnapshot("next");
  assert.equal(ready.messages.filter((message: ChatMessage) => message.role === "user").length, 1);
  assert.equal(ready.messages.find((message: ChatMessage) => message.role === "user").id, persisted.id);
  assert.deepEqual(ready.turnEvents, []);
  f.reply.resolve();
  await sent;
});

for (const kind of ["reject", "handled"] as const) {
  test(`${kind} before SDK delivery removes the pending row, unlocks and restores the prompt`, async (t) => {
    const f = await fixture(t, { [kind]: true });
    const sent = f.context.sendUserMessage("keep this prompt");
    if (kind === "reject") await assert.rejects(sent, /API key/);
    else await sent;
    assert.deepEqual(f.messages, []);
    assert.deepEqual(f.statuses, {});
    assert.deepEqual(f.restored, ["keep this prompt"]);
    assert.equal(f.host.openingPrompts.size, 0);
    assert.equal(f.events.filter((event) => event.type === "opening_prompt_cancelled").length, 1);
    assert.deepEqual((await f.host.getSnapshot("next")).messages, []);
  });
}

test("replayed opening events do not duplicate snapshot rows, and cancellation is scoped to its id", () => {
  const row: ChatMessage = { id: "local:opening", role: "user", text: "next", tools: [], parts: [] };
  const other: ChatMessage = { ...row, id: "local:other", text: "other" };
  assert.deepEqual(apply([row], { type: "opening_prompt", message: row }, false).messages, [row]);
  assert.deepEqual(apply([row, other], { type: "opening_prompt_cancelled", messageId: row.id }, false).messages, [other]);
});
