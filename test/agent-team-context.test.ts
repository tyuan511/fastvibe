import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, type ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { createFauxCore, fauxAssistantMessage, fauxToolCall, InMemoryModelsStore } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { agentTeamContextExtension, agentTeamRoster, AGENT_TEAM_RESULT, AGENT_TEAM_ROSTER } from "../src/main/engine/agent-team-context.ts";
import { AgentThreadStore } from "../src/main/engine/agent-thread-store.ts";
import { writeTranscriptEntries } from "../src/main/engine/transcript-file.ts";
import { openTestDb } from "./test-db.ts";

type Message = { role: string; content: unknown; customType?: string };

async function harness(t: TestContext, options: { extension?: ExtensionFactory; responses?: ReturnType<typeof fauxAssistantMessage>[]; teamTools?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "agent-team-context-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const db = openTestDb(dir);
  t.after(() => db.close());
  const store = new AgentThreadStore(db);
  const requests: Message[][] = [];
  const faux = createFauxCore({ api: "faux-api", provider: "faux", models: [{ id: "scripted" }] });
  faux.setResponses(options.responses ?? Array.from({ length: 20 }, () => fauxAssistantMessage("done")));
  const runtime = await ModelRuntime.create({ credentials: undefined, authPath: join(dir, "auth.json"), modelsPath: null, modelsStore: new InMemoryModelsStore(), allowModelNetwork: false, refreshOnCreate: false });
  runtime.registerProvider("faux", {
    baseUrl: "http://faux.invalid", api: "faux-api" as never, apiKey: "unused",
    streamSimple: ((model: unknown, context: { messages: Message[] }, opts: unknown) => {
      requests.push(structuredClone(context.messages));
      return (faux.streamSimple as (...args: unknown[]) => unknown)(model, context, opts);
    }) as never,
    models: [{ id: "scripted", name: "scripted", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100_000, maxTokens: 4096 }],
  });
  const cwd = join(dir, "project"), agentDir = join(dir, "agent");
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
  let sessionManager = SessionManager.create(cwd, join(dir, "sessions"));
  let durable = true;
  let persistenceCalls = 0;
  const persist = () => {
    persistenceCalls++;
    if (!durable) return false;
    const manager = sessionManager as unknown as { flushed: boolean; fileEntries: unknown[] };
    if (!manager.flushed) {
      writeTranscriptEntries(sessionManager.getSessionFile()!, manager.fileEntries);
      manager.flushed = true;
    }
    return true;
  };
  const loader = () => new DefaultResourceLoader({ cwd, agentDir, settingsManager,
    noSkills: true, noContextFiles: true, noExtensions: true,
    additionalExtensionPaths: options.teamTools ? [fileURLToPath(new URL("../resources/extensions/subagent/index.ts", import.meta.url))] : [],
    extensionFactories: [{ name: "agent-team-context", hidden: true, factory: agentTeamContextExtension({ conversationId: "a", store, sessionManager, persist }) }, ...(options.extension ? [{ name: "test-tools", hidden: true, factory: options.extension }] : [])],
  });
  const open = async () => {
    const resourceLoader = loader();
    await resourceLoader.reload();
    return (await createAgentSession({ cwd, agentDir, modelRuntime: runtime, model: runtime.getModel("faux", "scripted"), sessionManager, settingsManager, resourceLoader })).session;
  };
  let session = await open();
  t.after(() => session.dispose());
  const create = (id: string, conversationId = "a") => store.create({ id, taskName: id, conversationId, task: "inspect", cwd, status: "working", currentTurn: 1 });
  const notices = () => sessionManager.getBranch().filter((entry) => entry.type === "custom_message" && entry.customType === AGENT_TEAM_RESULT);
  return { store, requests, create, persist, notices,
    get session() { return session; }, get manager() { return sessionManager; },
    get persistenceCalls() { return persistenceCalls; }, set durable(value: boolean) { durable = value; },
    async reopen() {
      const file = sessionManager.getSessionFile()!;
      session.dispose();
      sessionManager = SessionManager.open(file);
      session = await open();
    },
  };
}

const body = (messages: Message[]): string => JSON.stringify(messages);

test("roster is request-local, bounded, escaped and scoped to the owning conversation", async (t) => {
  const h = await harness(t);
  h.create('worker-"<one>'); h.create("private-other-chat", "b");
  await h.session.prompt("inspect existing agents");
  assert.match(body(h.requests.at(-1)!), /<subagents>/);
  assert.match(body(h.requests.at(-1)!), /&quot;&lt;one&gt;/);
  assert.doesNotMatch(body(h.requests.at(-1)!), /private-other-chat/);
  assert.equal(h.manager.getBranch().some((entry) => entry.type === "custom_message" && entry.customType === AGENT_TEAM_ROSTER), false);
  const threads = Array.from({ length: 20 }, (_, i) => h.create(`long-${i}-${"中文".repeat(50)}`));
  const roster = agentTeamRoster(threads);
  assert.ok((roster.match(/<agent /g) ?? []).length <= 8);
  assert.ok(Buffer.byteLength(roster.slice(roster.indexOf("<subagents>"))) <= 1024);
});

test("completed mail waits while idle, is persisted once on a request, and survives reopening", async (t) => {
  const h = await harness(t);
  h.create("worker");
  h.store.finishTurn("worker", 1, "completed", "verified output");
  assert.equal(h.requests.length, 0, "a result must not start a parent turn");
  assert.equal(h.store.pendingResults("a").length, 1);
  await h.session.prompt("continue the work");
  assert.match(body(h.requests.at(-1)!), /Message Type: FINAL_ANSWER/);
  assert.match(body(h.requests.at(-1)!), /Sender: worker/);
  assert.match(body(h.requests.at(-1)!), /verified output/);
  assert.equal(h.notices().length, 1);
  assert.equal(h.notices()[0].display, false);
  assert.deepEqual(h.store.pendingResults("a"), []);
  await h.reopen();
  await h.session.prompt("what did the worker find?");
  assert.equal(h.notices().length, 1);
  assert.match(body(h.requests.at(-1)!), /verified output/);
  assert.equal((body(h.requests.at(-1)!).match(/Message Type: FINAL_ANSWER/g) ?? []).length, 1);
});

test("continue through the SDK run wrapper refreshes roster and drains mail without before_agent_start", async (t) => {
  const h = await harness(t);
  await h.session.prompt("start");
  h.create("new-after-stop");
  h.store.finishTurn("new-after-stop", 1, "failed", "", "network failed");
  const raw = h.session as unknown as { _startRun(trigger: unknown): Promise<void>; _prepareRun: (trigger: unknown) => Promise<unknown> };
  const prepare = raw._prepareRun;
  raw._prepareRun = async () => [];
  try { await raw._startRun({ messageType: "user", prompt: "" }); }
  finally { raw._prepareRun = prepare; }
  const last = body(h.requests.at(-1)!);
  assert.match(last, /new-after-stop/);
  assert.match(last, /Status: failed/);
  assert.match(last, /network failed/);
  assert.match(last, /followup_task/);
  assert.equal(h.notices().length, 1);
});

test("the real collaboration extension keeps static coordination guidance on Continue", async (t) => {
  const h = await harness(t, { teamTools: true });
  await h.session.prompt("start a task");
  const raw = h.session as unknown as { _startRun(trigger: unknown): Promise<void>; _prepareRun: (trigger: unknown) => Promise<unknown> };
  const prepare = raw._prepareRun;
  raw._prepareRun = async () => [];
  try { await raw._startRun({ messageType: "user", prompt: "" }); }
  finally { raw._prepareRun = prepare; }
  const system = body(h.requests.at(-1)!.filter((message) => message.role === "system"));
  assert.match(system, /root \(main\) agent/);
  assert.match(system, /A user Stop/);
  assert.match(system, /followup_task/);
  assert.match(system, /FINAL_ANSWER/);
});

test("a result arriving during a tool call is inserted after all tool results before the next request", async (t) => {
  let finish!: () => void;
  const h = await harness(t, {
    responses: [fauxAssistantMessage([fauxToolCall("finish_child", {}, { id: "call-child" })]), fauxAssistantMessage("collected")],
    extension: (pi) => pi.registerTool({ name: "finish_child", label: "Finish", description: "Finish child", parameters: Type.Object({}),
      async execute() { finish(); return { content: [{ type: "text", text: "tool finished" }], details: {} }; },
    }),
  });
  h.create("worker");
  finish = () => { h.store.finishTurn("worker", 1, "completed", "child finished during tool"); };
  await h.session.prompt("do work");
  assert.equal(h.requests.length, 2);
  assert.match(body(h.requests[1]), /child finished during tool/);
  const branch = h.manager.getBranch();
  const result = branch.findIndex((entry) => entry.type === "message" && entry.message.role === "toolResult");
  const mail = branch.findIndex((entry) => entry.type === "custom_message" && entry.customType === AGENT_TEAM_RESULT);
  assert.ok(result >= 0 && mail > result, "mail must not split tool calls and their results");
  assert.equal(h.notices().length, 1);
});

test("failed persistence leaves mail pending, and retry acknowledges the existing notice without duplicating it", async (t) => {
  const h = await harness(t);
  h.create("worker");
  h.store.finishTurn("worker", 1, "completed", "durable evidence");
  h.durable = false;
  await h.session.prompt("first");
  assert.equal(h.store.pendingResults("a").length, 1);
  assert.equal(h.notices().length, 1);
  await h.reopen();
  h.durable = true;
  await h.session.prompt("retry");
  assert.equal(h.notices().length, 1);
  assert.deepEqual(h.store.pendingResults("a"), []);
});

test("a large result is bounded in model context while its full history is retained", async (t) => {
  const h = await harness(t);
  h.create("worker");
  const output = "evidence".repeat(2000) + "FULL_RESULT_END";
  h.store.finishTurn("worker", 1, "completed", output);
  await h.session.prompt("collect bounded evidence");
  const request = body(h.requests.at(-1)!);
  assert.match(request, /Result truncated for context/);
  assert.doesNotMatch(request, /FULL_RESULT_END/);
  assert.equal(h.store.messages("worker")[0].text, output);
});

test("compaction and branching refresh existing identities without replaying delivered results", async (t) => {
  const h = await harness(t);
  h.create("worker");
  await h.session.prompt("first");
  const firstLeaf = h.manager.getLeafId()!;
  h.store.finishTurn("worker", 1, "completed", "past result");
  await h.session.prompt("collect");
  const lastUser = h.manager.getBranch().findLast((entry) => entry.type === "message" && entry.message.role === "user")!;
  h.manager.appendCompaction("earlier tasks summarized", lastUser.id, 1000);
  await h.session.reload();
  await h.session.prompt("after compaction");
  assert.match(body(h.requests.at(-1)!), /<agent id=\\"worker/);
  h.manager.branch(firstLeaf);
  await h.session.reload();
  await h.session.prompt("on an older branch");
  assert.match(body(h.requests.at(-1)!), /<subagents>/);
  assert.doesNotMatch(body(h.requests.at(-1)!), /Message Type: FINAL_ANSWER/);
});

test("mail arriving with the parent's final answer waits for the next explicit turn", async (t) => {
  let finish!: () => void;
  let finished = false;
  const h = await harness(t, { extension: (pi) => {
    pi.on("message_end", (event) => {
      if (!finished && event.message.role === "assistant") { finished = true; finish(); }
    });
  } });
  h.create("worker");
  finish = () => { h.store.finishTurn("worker", 1, "completed", "arrived at answer boundary"); };
  await h.session.prompt("answer the current question");
  assert.equal(h.requests.length, 1, "result arrival must not add an unsolicited model request");
  assert.equal(h.store.pendingResults("a").length, 1);
  assert.equal(h.notices().length, 0);
  await h.session.prompt("read the result now");
  assert.match(body(h.requests.at(-1)!), /arrived at answer boundary/);
  assert.equal(h.store.pendingResults("a").length, 0);
});

test("a user-interrupted child does not manufacture a completion message", async (t) => {
  const h = await harness(t);
  h.create("stopped");
  h.store.finishTurn("stopped", 1, "interrupted", "partial changes");
  await h.session.prompt("continue");
  assert.match(body(h.requests.at(-1)!), /stopped/);
  assert.doesNotMatch(body(h.requests.at(-1)!), /FINAL_ANSWER|partial changes/);
  assert.equal(h.notices().length, 0);
});
