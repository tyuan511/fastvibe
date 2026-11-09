import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const ts = require("typescript") as typeof import("typescript");
const source = readFileSync(new URL("../resources/extensions/subagent/index.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;

function loadExtension() {
  let discoveredCwd = "";
  const tools = new Map<string, any>();
  let beforeStart: ((event: any, ctx: any) => any) | undefined;
  const stringEnum = (values: unknown) => ({ type: "string", values });
  const type = {
    Object: (properties: unknown) => ({ type: "object", properties }),
    String: (options?: unknown) => ({ type: "string", options }),
    Optional: (schema: unknown) => schema,
    Array: (schema: unknown) => ({ type: "array", items: schema }),
    Integer: (options?: unknown) => ({ type: "integer", options }),
  };
  const deps: Record<string, unknown> = {
    "@earendil-works/pi-ai": { StringEnum: stringEnum },
    typebox: { Type: type },
    "./agents": {
      discoverAgents: (cwd: string) => {
        discoveredCwd = cwd;
        return { agents: [{ name: "worker", description: "Owned implementation", systemPrompt: "Work within ownership.", tools: ["read", "edit"], thinkingLevel: "medium" }] };
      },
    },
  };
  const exports = {};
  new Function("require", "exports", compiled)(
    (name: string) => {
      if (Object.hasOwn(deps, name)) return deps[name];
      throw new Error(`Unexpected dependency: ${name}`);
    },
    exports,
  );
  const extension = (exports as { default: (pi: any) => void }).default;
  extension({
    on(event: string, handler: any) {
      assert.equal(event, "before_agent_start");
      beforeStart = handler;
    },
    registerTool(tool: any) { tools.set(tool.name, tool); },
  });
  return { tools, beforeStart: beforeStart!, get discoveredCwd() { return discoveredCwd; } };
}

test("host beforeStart preserves the base prompt, uses ctx.cwd, and adds the current roster", () => {
  const loaded = loadExtension();
  const prompt = loaded.beforeStart({ systemPrompt: "base" }, { cwd: "/project/owned" }).systemPrompt;
  assert.equal(loaded.discoveredCwd, "/project/owned");
  assert.equal(prompt, "base\n\nAvailable Agent Team roles for this project: worker — Owned implementation.");
  assert.ok(!prompt.includes("root (main) agent"));
  loaded.beforeStart({ systemPrompt: "next" }, { cwd: "/another-project" });
  assert.equal(loaded.discoveredCwd, "/another-project");
});

test("spawn prompt rules carry the shared team guidance and collaboration tools carry concrete guidance", async () => {
  const loaded = loadExtension();
  const spawnRules = loaded.tools.get("spawn_agent").promptGuidelines.join("\n");
  for (const phrase of [
    "root (main) agent",
    "independent, useful work proactively",
    "explorer role",
    "worker role",
    "same filesystem",
    "never revert, reset, or overwrite",
    "thread IDs and task names",
    "interruption, reload, compaction, or continuation",
    "A user Stop",
    "Resume only after the user asks to continue and the same task is still relevant",
    "recheck the filesystem for partial effects",
    "thread sender, turn, and status",
    "Ordinary interrupted turns do not send a notification",
    "not a promise of exact original execution continuation",
    "list_agents",
    "followup_task",
    "FINAL_ANSWER",
    "several minutes",
    "do not recursively become coordinators",
    "do not inherit the full parent tool set",
  ]) assert.ok(spawnRules.includes(phrase), phrase);

  for (const name of ["spawn_agent", "send_message", "followup_task", "list_agents", "wait_agent"]) {
    const tool = loaded.tools.get(name);
    assert.ok(tool, name);
    assert.ok(tool.promptGuidelines && tool.promptGuidelines.length >= 2, name);
  }
  assert.match(loaded.tools.get("spawn_agent").description, /explorer/);
  assert.match(loaded.tools.get("followup_task").description, /interrupted/);
  assert.match(loaded.tools.get("send_message").description, /without starting or resuming/);
  assert.match(loaded.tools.get("wait_agent").description, /selected agent threads/);
  assert.match(loaded.tools.get("wait_agent").description, /result update/);
  assert.match(loaded.tools.get("wait_agent").description, /other selected threads finish/);
  assert.match(loaded.tools.get("wait_agent").description, /full results are delivered automatically/);
  assert.match(loaded.tools.get("wait_agent").description, /FINAL_ANSWER/);

  const controller = new AbortController();
  let request: any;
  const result = [{ id: "thread-1", status: "completed" }];
  const ctx = {
    cwd: "/project",
    ui: {
      conversationId: "root",
      waitAgents: async (value: any) => { request = value; return result; },
    },
  };
  const response = await loaded.tools.get("wait_agent").execute("call", { targets: ["thread-1"], timeout_ms: 120000 }, controller.signal, undefined, ctx);
  assert.deepEqual(response.details.threads, result);
  assert.equal(request.threadIds[0], "thread-1");
  assert.equal(request.timeoutMs, 120000);
  assert.equal(request.signal, controller.signal);
  const cancelled = new DOMException("Wait cancelled", "AbortError");
  const waiting = loaded.tools.get("wait_agent").execute("cancel", {}, controller.signal, undefined, {
    ...ctx,
    ui: { waitAgents: ({ signal }: { signal: AbortSignal }) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(cancelled), { once: true });
    }) },
  });
  controller.abort();
  await assert.rejects(waiting, (error) => error === cancelled);
});

test("mailbox sends do not start turns and spawn retains its original signal forwarding", async () => {
  const { tools } = loadExtension();
  const calls: Array<{ method: string; request: any }> = [];
  const record = (method: string) => async (request: any) => { calls.push({ method, request }); return { id: "existing" }; };
  const ctx = {
    cwd: "/owned-project",
    model: { provider: "fake", id: "model" },
    ui: {
      conversationId: "parent",
      sendAgentMessage: record("send"),
      followupAgent: record("followup"),
      spawnAgent: record("spawn"),
    },
  };
  const signal = new AbortController().signal;
  await tools.get("send_message").execute("send", { target: "existing", message: "New evidence" }, signal, undefined, ctx);
  assert.deepEqual(calls, [{ method: "send", request: { threadId: "existing", message: "New evidence", senderId: "parent" } }]);
  await tools.get("followup_task").execute("followup", { target: "existing", message: "Check partial edits" }, signal, undefined, ctx);
  assert.deepEqual(calls[1], { method: "followup", request: { threadId: "existing", message: "Check partial edits", senderId: "parent" } });
  const spawn = tools.get("spawn_agent");
  await spawn.execute("spawn", { message: "Own src/one.ts", task_name: "owned-work" }, signal, undefined, ctx);
  assert.equal(calls[2].method, "spawn");
  assert.equal(calls[2].request.signal, signal);
  assert.equal(calls[2].request.cwd, ctx.cwd);
  assert.equal(calls[2].request.fallbackModel, "fake/model");
  assert.equal(calls[2].request.forkTurns, "all");
  const cancelled = new AbortController(); cancelled.abort();
  const refused = await spawn.execute("cancelled", { message: "Do not spawn", task_name: "cancelled" }, cancelled.signal, undefined, ctx);
  assert.equal(refused.isError, true);
  assert.equal(calls.length, 3);
});

test("list_agents answers with a bounded digest and a no-change shortcut", async () => {
  const loaded = loadExtension();
  const thread = {
    id: "agent-a", name: "Ray", agent: "worker", status: "working", phase: "waiting", currentTurn: 2,
    task: "T".repeat(400), lastMessage: "L".repeat(900), systemPrompt: "S".repeat(5000),
    tools: ["read", "edit"], cwd: "/repo", revision: 3,
  };
  let threads = [thread];
  const ctx = { cwd: "/project", ui: { conversationId: "root", listAgentThreads: async () => threads } };
  const tool = loaded.tools.get("list_agents");

  const first = await tool.execute("call-1", {}, undefined, undefined, ctx);
  const text = first.content[0].text;
  assert.match(text, /Agent Team threads \(1\)/);
  assert.match(text, /name=Ray agent=worker status=working\/waiting turn=2/);
  assert.ok(text.includes(`task="${"T".repeat(200)}…"`));
  assert.ok(text.includes(`last="${"L".repeat(400)}…"`));
  assert.ok(!text.includes("S".repeat(100)), "system prompts must stay out of the digest");
  assert.ok(!text.includes("T".repeat(201)));
  assert.deepEqual(first.details.threads, [thread]);

  const again = await tool.execute("call-2", {}, undefined, undefined, ctx);
  assert.match(again.content[0].text, /no changes since your last list_agents/);
  assert.ok(!again.content[0].text.includes('task="'));
  assert.deepEqual(again.details.threads, [thread]);

  threads = Array.from({ length: 13 }, (_, index) => ({ ...thread, id: `agent-${index}`, revision: 4 }));
  const changed = await tool.execute("call-3", {}, undefined, undefined, ctx);
  assert.ok(changed.content[0].text.includes('task="'));
  assert.ok(!changed.content[0].text.includes("no changes"));
  assert.match(changed.content[0].text, /…and 1 more threads not shown\./);

  const other = await tool.execute("call-4", {}, undefined, undefined, { ...ctx, ui: { ...ctx.ui, conversationId: "branch" } });
  assert.ok(!other.content[0].text.includes("no changes"), "a new conversation starts with a full digest");
});

test("spawn and wait answers are one-line digests while details keep full threads", async () => {
  const loaded = loadExtension();
  const thread = {
    id: "agent-new", name: "Ray", agent: "worker", status: "working", currentTurn: 1,
    task: "W".repeat(300), lastMessage: "L".repeat(900), systemPrompt: "S".repeat(4000), revision: 1,
  };
  const spawn = await loaded.tools.get("spawn_agent").execute("spawn", { message: "Own src", task_name: "owned-work" }, undefined, undefined, {
    cwd: "/owned-project",
    ui: { conversationId: "parent", spawnAgent: async () => thread },
  });
  assert.match(spawn.content[0].text, /^已创建 Agent thread agent-new name=Ray agent=worker status=working/);
  assert.ok(spawn.content[0].text.includes(`task="${"W".repeat(200)}…"`));
  assert.ok(!spawn.content[0].text.includes("S".repeat(100)));
  assert.equal(spawn.details.thread.id, "agent-new");
  assert.equal(spawn.details.thread.systemPrompt.length, 4000);

  const wait = await loaded.tools.get("wait_agent").execute("wait", {}, undefined, undefined, {
    cwd: "/project",
    ui: { conversationId: "root", waitAgents: async () => [thread] },
  });
  assert.match(wait.content[0].text, /FINAL_ANSWER messages/);
  assert.ok(wait.content[0].text.includes(`last="${"L".repeat(400)}…"`));
  assert.deepEqual(wait.details.threads, [thread]);
});
