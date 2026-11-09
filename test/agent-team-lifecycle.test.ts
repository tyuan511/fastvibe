import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test, { type TestContext } from "node:test";
import { agentThreadFinished } from "../src/shared/agent-thread.ts";
import { AgentThreadStore } from "../src/main/engine/agent-thread-store.ts";
import { openTestDb, testDir } from "./test-db.ts";

// Run Main's actual completion and wait methods without Electron or a paid model.
const ts = createRequire(import.meta.url)("typescript") as typeof import("typescript");
const source = readFileSync(new URL("../src/main/pi/process-manager.ts", import.meta.url), "utf8");
const file = ts.createSourceFile("manager.ts", source, ts.ScriptTarget.Latest, true);
const methods: string[] = [];
let lastAssistantText = "";
function visit(node: import("typescript").Node): void {
  if (ts.isMethodDeclaration(node) && ["#trackAgentThreadRun", "sendAgentMessage", "followupAgent", "waitAgents"].includes(node.name.getText(file))) methods.push(node.getText(file).replaceAll("#", ""));
  if (ts.isFunctionDeclaration(node) && node.name?.text === "lastAssistantText") lastAssistantText = node.getText(file);
  ts.forEachChild(node, visit);
}
visit(file);
assert.equal(methods.length, 4);
assert.ok(lastAssistantText);
const compiled = ts.transpileModule(`${lastAssistantText}\nclass Harness { ${methods.join("\n")} }`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText;
const Harness = new Function("agentThreadFinished", `${compiled}; return Harness;`)(agentThreadFinished);
const response = (stopReason = "stop", errorMessage?: string) => ({ messages: [{ role: "assistant", content: [{ type: "text", text: "worker evidence" }] }], exitCode: stopReason === "stop" ? 0 : 1, stopReason, errorMessage });

function fixture(t: TestContext) {
  const db = openTestDb(testDir("agent-team-lifecycle-"));
  t.after(() => db.close());
  const store = new AgentThreadStore(db);
  const host = new Harness();
  const events: unknown[] = [];
  const runs: unknown[] = [];
  Object.assign(host, {
    agentThreads: store,
    agentThreadRunIds: new Map(),
    agentThreadRuns: new Map(),
    agentThreadWaiters: new Set(),
    subagentSessions: new Map(),
    subagentControls: new Map(),
    emit: (event: unknown) => events.push(event),
    runSubagent: (_conversationId: string, request: unknown) => { runs.push(request); return new Promise(() => {}); },
  });
  const create = (id: string) => store.create({ id, conversationId: "a", task: "inspect", cwd: "/repo", status: "working", currentTurn: 1 });
  const track = (id: string, run: Promise<unknown>) => {
    const runId = `${id}:turn:1`;
    host.agentThreadRunIds.set(id, runId); host.agentThreadRuns.set(id, run);
    host.trackAgentThreadRun(id, runId, 1, run);
  };
  return { host, store, events, runs, create, track };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

test("one result wakes wait_agent while siblings still run, after releasing its executor", async (t) => {
  const f = fixture(t);
  f.create("first"); f.create("second");
  const waiting = f.host.waitAgents({ conversationId: "a", timeoutMs: 10_000 });
  f.track("first", Promise.resolve(response()));
  const threads = await waiting;
  assert.equal(threads.find((thread: { id: string }) => thread.id === "second").status, "working");
  assert.equal(f.store.pendingResults("a").length, 1);
  assert.equal(f.host.agentThreadRuns.has("first"), false);
  assert.equal(f.host.agentThreadRunIds.has("first"), false);
  assert.equal(f.host.agentThreadWaiters.size, 0);
  assert.equal(f.events.length, 1);
});

test("targeted waits ignore unrelated results and cancellation immediately releases their waiter", async (t) => {
  const f = fixture(t);
  f.create("first"); f.create("second");
  const controller = new AbortController();
  const waiting = f.host.waitAgents({ conversationId: "a", threadIds: ["second"], signal: controller.signal, timeoutMs: 10_000 });
  const rejected = assert.rejects(waiting, { name: "AbortError" });
  f.track("first", Promise.resolve(response()));
  await tick();
  assert.equal(f.host.agentThreadWaiters.size, 1);
  controller.abort();
  await rejected;
  assert.equal(f.host.agentThreadWaiters.size, 0);
});

test("an already cancelled wait cannot register a parked waiter", async (t) => {
  const f = fixture(t);
  await assert.rejects(f.host.waitAgents({ conversationId: "a", signal: AbortSignal.abort() }), { name: "AbortError" });
  assert.equal(f.host.agentThreadWaiters.size, 0);
});

test("failed and unexpectedly rejected runners both notify the parent with an error", async (t) => {
  const f = fixture(t);
  f.create("failed"); f.create("rejected");
  f.track("failed", Promise.resolve(response("error", "provider refused")));
  f.track("rejected", Promise.reject(new Error("setup failed")));
  await tick();
  assert.equal(f.store.get("failed")?.status, "failed");
  assert.equal(f.store.get("rejected")?.status, "failed");
  assert.match(f.store.pendingResults("a").find((mail) => mail.threadId === "failed")!.text, /provider refused/);
  assert.match(f.store.pendingResults("a").find((mail) => mail.threadId === "rejected")!.text, /setup failed/);
});

test("interrupted runners wake status waits but do not enqueue final-answer notifications", async (t) => {
  const f = fixture(t);
  f.create("stopped");
  const waiting = f.host.waitAgents({ conversationId: "a", timeoutMs: 10_000 });
  f.track("stopped", Promise.resolve(response("aborted")));
  await waiting;
  assert.equal(f.store.get("stopped")?.status, "interrupted");
  assert.deepEqual(f.store.pendingResults("a"), []);
});

test("failed outcome persistence does not leave a resolved runner blocking a later follow-up", async (t) => {
  const f = fixture(t);
  f.create("worker");
  const logged = t.mock.method(console, "error", () => {});
  f.store.finishTurn = () => { throw new Error("disk full"); };
  f.track("worker", Promise.resolve(response()));
  await tick();
  assert.equal(f.host.agentThreadRuns.has("worker"), false);
  assert.equal(f.host.agentThreadRunIds.has("worker"), false);
  assert.equal(f.store.get("worker")?.status, "working", "failed persistence must not claim completion");
  assert.equal(logged.mock.callCount(), 1);
});

test("a stale completion cannot clear a newer runner or overwrite its status", async (t) => {
  const f = fixture(t);
  f.create("worker");
  let resolve!: (value: unknown) => void;
  f.track("worker", new Promise((done) => { resolve = done; }));
  const newer = Promise.resolve(response());
  f.host.agentThreadRunIds.set("worker", "worker:turn:2");
  f.host.agentThreadRuns.set("worker", newer);
  f.store.patch("worker", { currentTurn: 2 });
  resolve(response());
  await tick();
  assert.equal(f.host.agentThreadRuns.get("worker"), newer);
  assert.equal(f.store.get("worker")?.status, "working");
  assert.deepEqual(f.store.pendingResults("a"), []);
});

test("followup_task prompts the new turn with the mailbox message, not a short label", async (t) => {
  const f = fixture(t);
  f.create("worker");
  f.store.send("worker", "root", "earlier evidence");
  // Legacy clients may still attach the old short-label override; it must not win.
  await f.host.followupAgent({ conversationId: "a", threadId: "worker", message: "Recheck the Electron UI", task: "electron-locate", senderId: "root" });
  assert.equal(f.runs.length, 1);
  assert.equal(f.runs[0].task, "Recheck the Electron UI");
  assert.equal(f.store.get("worker")?.task, "Recheck the Electron UI");
  assert.equal(f.store.get("worker")?.status, "working");
  assert.equal(f.store.messages("worker").some((m) => m.kind === "message" && m.text === "Recheck the Electron UI"), true);
  assert.equal(f.runs[0].systemPrompt.includes("earlier evidence"), true);
  assert.equal(f.runs[0].systemPrompt.includes("Recheck the Electron UI"), false);
});

test("a followup to a running thread only steers and does not start a second turn", async (t) => {
  const f = fixture(t);
  f.create("worker");
  let resolve!: (value: unknown) => void;
  f.track("worker", new Promise((done) => { resolve = done; }));
  f.host.subagentSessions.set("worker:turn:1", { steer: async () => {} });
  await f.host.followupAgent({ conversationId: "a", threadId: "worker", message: "Add this correction", senderId: "root" });
  assert.equal(f.runs.length, 0);
  assert.equal(f.store.get("worker")?.currentTurn, 1);
  assert.equal(f.store.messages("worker").some((m) => m.kind === "message" && m.text === "Add this correction"), true);
  resolve(response());
});

test("finishTurn keeps the mailbox result full but bounds the sidebar lastMessage snippet", (t) => {
  const f = fixture(t);
  f.create("worker");
  const output = `${"x".repeat(5000)} tail marker`;
  f.store.finishTurn("worker", 1, "completed", output);
  const thread = f.store.get("worker")!;
  assert.equal(thread.lastMessage!.length, 2001);
  assert.ok(thread.lastMessage!.endsWith("…"));
  assert.equal(f.store.messages("worker").find((mail) => mail.kind === "result")!.text, output);
});
