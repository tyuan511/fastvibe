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
  assert.match(loaded.tools.get("wait_agent").description, /actual results/);
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
  await tools.get("followup_task").execute("followup", { target: "existing", message: "Check partial edits", task: "Finish owned file" }, signal, undefined, ctx);
  assert.deepEqual(calls[1], { method: "followup", request: { threadId: "existing", message: "Check partial edits", task: "Finish owned file", senderId: "parent" } });
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
