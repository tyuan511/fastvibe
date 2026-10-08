import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { beforeEach, test } from "node:test";
import { Agent } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import question from "../resources/extensions/question.ts";

// Exercise Main's actual dialog lifecycle without loading Electron, as in subagent-run.test.ts.
const ts = createRequire(import.meta.url)("typescript") as typeof import("typescript");
const source = readFileSync(new URL("../src/main/pi/process-manager.ts", import.meta.url), "utf8");
const file = ts.createSourceFile("manager.ts", source, ts.ScriptTarget.Latest, true);
const methods: string[] = [];
function visit(node: import("typescript").Node): void {
  if (ts.isMethodDeclaration(node) && ["#extensionUi", "respondPermission", "#resolvePendingUi"].includes(node.name.getText(file))) {
    methods.push(node.getText(file));
  }
  ts.forEachChild(node, visit);
}
visit(file);
assert.equal(methods.length, 3);
const compiled = ts.transpileModule(`class Harness { ${methods.join("\n").replaceAll("#", "")} }`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText;
const Harness = new Function("randomUUID", `${compiled}; return Harness;`)(randomUUID);
const WAIT_MS = 5 * 60_000;
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

beforeEach((t) => {
  const previous = process.env.FASTVIBE_UI_LANGUAGE;
  process.env.FASTVIBE_UI_LANGUAGE = "en";
  t.after(() => {
    if (previous === undefined) delete process.env.FASTVIBE_UI_LANGUAGE;
    else process.env.FASTVIBE_UI_LANGUAGE = previous;
  });
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
});

function fixture(fallback = false) {
  const events: any[] = [];
  const host = new Harness();
  Object.assign(host, { pendingUi: new Map(), subagentControls: new Map(), emit: (event: any) => events.push(event) });
  const ui = host.extensionUi("chat");
  if (fallback) delete ui.questions;
  let tool!: ToolDefinition<any>;
  question({ registerTool: (value: ToolDefinition<any>) => { tool = value; } } as ExtensionAPI);
  const execute = (questions: unknown[], signal = new AbortController().signal) =>
    tool.execute("call", { questions }, signal, undefined, { hasUI: true, ui } as never);
  return {
    host, events, tool, execute, ui,
    requests: () => events.filter((event) => event.type === "extension_ui_request"),
    dismissals: () => events.filter((event) => event.type === "extension_ui_dismiss"),
    reply: (response: Record<string, unknown>) => host.respondPermission({ id: events.findLast((event) => event.type === "extension_ui_request").id, ...response }),
  };
}

const questions = [{ question: "Which colour?", options: [{ label: "Blue" }, { label: "Green" }] }];

test("expiry dismisses the question and the real agent loop requests its next response", async (t) => {
  const f = fixture();
  t.after(() => f.host.resolvePendingUi());
  let calls = 0;
  let resumedMessages: any[] = [];
  const agent = new Agent({
    initialState: {
      systemPrompt: "", model: { provider: "fake", id: "m", api: "openai-completions" },
      tools: [{ ...f.tool, execute: (_id: string, params: any, signal: AbortSignal) => f.execute(params.questions, signal) }],
    },
    convertToLlm: (messages: any[]) => messages,
    streamFn: (_model: unknown, context: { messages: any[] }) => {
      calls++;
      assert.ok(calls <= 2, "the continuation must not loop");
      if (calls === 2) resumedMessages = [...context.messages];
      const message = {
        role: "assistant", provider: "fake", model: "m", timestamp: Date.now(),
        stopReason: calls === 1 ? "toolUse" : "stop",
        content: calls === 1 ? [{ type: "toolCall", id: "call", name: "question", arguments: { questions } }] : [{ type: "text", text: "Continuing independent work." }],
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      };
      return {
        async *[Symbol.asyncIterator]() { yield { type: "done", reason: message.stopReason, message }; },
        result: async () => message,
      };
    },
  } as never);
  const run = agent.prompt("Do the work.");
  await flush();
  const request = f.requests()[0];
  assert.equal(request.timeout, WAIT_MS);
  assert.equal(agent.state.isStreaming, true);
  t.mock.timers.tick(WAIT_MS - 1);
  await flush();
  assert.equal(calls, 1);
  assert.equal(f.host.pendingUi.size, 1);
  t.mock.timers.tick(1);
  await run;
  assert.equal(calls, 2);
  assert.equal(agent.state.isStreaming, false);
  assert.equal(f.host.pendingUi.size, 0);
  assert.deepEqual(f.dismissals(), [{ type: "extension_ui_dismiss", id: request.id, conversationId: "chat" }]);
  const result = resumedMessages.find((message) => message.role === "toolResult");
  assert.equal(result.isError, false);
  assert.equal(result.details.questions[0].answer, null);
  assert.match(result.content[0].text, /Continue work that does not depend/);
  assert.match(result.content[0].text, /Do not treat silence as consent/);
  assert.match(result.content[0].text, /immediately ask the same questions again/);
});

test("answered and manually cancelled questions clear their timers", async (t) => {
  const f = fixture();
  t.after(() => f.host.resolvePendingUi());
  const answered = f.execute(questions);
  t.mock.timers.tick(10_000);
  f.reply({ answers: ["Blue"] });
  const result = await answered;
  assert.equal(result.details.questions[0].answer, "Blue");
  assert.equal(result.details.questions[0].source, "option");
  assert.doesNotMatch(result.content[0].text, /not answered|consent/);
  const cancelled = f.execute(questions);
  f.reply({ cancelled: true });
  assert.equal((await cancelled).details.questions[0].answer, null);
  t.mock.timers.tick(WAIT_MS);
  assert.equal(f.host.pendingUi.size, 0);
  assert.deepEqual(f.dismissals(), []);
});

test("a late reply to an expired question cannot answer the next question", async (t) => {
  const f = fixture();
  t.after(() => f.host.resolvePendingUi());
  const expired = f.execute(questions);
  const oldId = f.requests()[0].id;
  t.mock.timers.tick(WAIT_MS);
  await expired;
  const next = f.execute(questions);
  f.host.respondPermission({ id: oldId, answers: ["Green"] });
  assert.equal(f.host.pendingUi.size, 1);
  f.reply({ answers: ["Blue"] });
  assert.equal((await next).details.questions[0].answer, "Blue");
});

test("fallback selection and custom input share one deadline and preserve earlier answers", async (t) => {
  const f = fixture(true);
  t.after(() => f.host.resolvePendingUi());
  const run = f.execute([...questions, { question: "Which size?" }, { question: "Which shape?" }]);
  assert.equal(f.requests()[0].method, "select");
  t.mock.timers.tick(120_000);
  f.reply({ value: "Other (type your own)" });
  await flush();
  assert.equal(f.requests()[1].method, "input");
  assert.equal(f.requests()[1].timeout, 180_000);
  t.mock.timers.tick(60_000);
  f.reply({ value: "Purple" });
  await flush();
  assert.equal(f.requests()[2].timeout, 120_000);
  t.mock.timers.tick(120_000);
  const result = await run;
  assert.deepEqual(result.details.questions.map((item: any) => item.answer), ["Purple", null, null]);
  assert.equal(result.details.questions[0].source, "custom");
  assert.equal(f.requests().length, 3, "expiry must not open another dialog");
  assert.equal(f.dismissals().length, 1);
  assert.equal(f.host.pendingUi.size, 0);
});

test("an answer arriving at the deadline cannot open an unbounded fallback input", async (t) => {
  const f = fixture(true);
  t.after(() => f.host.resolvePendingUi());
  const run = f.execute(questions);
  t.mock.timers.tick(WAIT_MS - 1);
  f.reply({ value: "Other (type your own)" });
  t.mock.timers.tick(1);
  const result = await run;
  assert.equal(result.details.questions[0].answer, null);
  assert.equal(f.requests().length, 1);
  assert.equal(f.host.pendingUi.size, 0);
});

test("stopping a question releases it immediately and clears its timeout", async (t) => {
  const f = fixture();
  const controller = new AbortController();
  const run = f.execute(questions, controller.signal);
  controller.abort();
  f.host.resolvePendingUi("chat");
  assert.equal((await run).details.questions[0].answer, null);
  t.mock.timers.tick(WAIT_MS);
  assert.equal(f.dismissals().length, 1);
  assert.equal(f.host.pendingUi.size, 0);
});
