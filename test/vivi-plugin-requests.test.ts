import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";

// Run the production host methods without importing Electron (question-timeout.test.ts).
const ts = createRequire(import.meta.url)("typescript") as typeof import("typescript");
const source = readFileSync(new URL("../src/main/pi/process-manager.ts", import.meta.url), "utf8");
const file = ts.createSourceFile("manager.ts", source, ts.ScriptTarget.Latest, true);
const names = ["#extensionUi", "respondPermission", "getPendingUi", "#resolvePendingUi"];
const methods: string[] = [];
let confirmTimeout = "";
function visit(node: import("typescript").Node): void {
  if (ts.isMethodDeclaration(node) && names.includes(node.name.getText(file))) methods.push(node.getText(file));
  if (ts.isVariableDeclaration(node) && node.name.getText(file) === "CONFIRM_TIMEOUT_MS") {
    confirmTimeout = node.initializer!.getText(file);
  }
  ts.forEachChild(node, visit);
}
visit(file);
assert.equal(methods.length, names.length);
assert.ok(confirmTimeout);
const compiled = ts.transpileModule(`const CONFIRM_TIMEOUT_MS = ${confirmTimeout}; class Harness {
  ${methods.join("\n").replaceAll("#", "")}
}`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
const Harness = new Function("randomUUID", `${compiled}; return Harness;`)(randomUUID);
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
type Reply = { confirmed?: boolean; value?: string; answers?: Array<string | null>; cancelled?: boolean };
type Request = { id: string; conversationId: string; method: string; [key: string]: unknown };
const questions = [{ question: "Choose", options: [{ label: "Blue" }, { label: "Green" }] }, { question: "Details?" }];
const cases = [
  { method: "confirm", args: ["Confirm", "Proceed?"], reply: { confirmed: false }, expected: false, fallback: false },
  { method: "select", args: ["Choose", ["Blue", "Green"]], reply: { value: "Green" }, expected: "Green", fallback: undefined },
  { method: "input", args: ["Details", "Type here"], reply: { value: "  exact text\nsecond line  " }, expected: "  exact text\nsecond line  ", fallback: undefined },
  { method: "editor", args: ["Edit", "Original\nsummary"], reply: { value: "" }, expected: "", fallback: undefined },
  { method: "questions", args: ["Questions", questions], reply: { answers: ["Green", null] }, expected: ["Green", null], fallback: undefined },
];

function fixture(t: import("node:test").TestContext) {
  const host = new Harness();
  const events: Request[] = [];
  Object.assign(host, {
    pendingUi: new Map(), subagentControls: new Map(),
    emit: (event: Request) => events.push(event),
  });
  t.after(() => host.resolvePendingUi());
  function ask(conversationId: string, item: typeof cases[number], args = item.args) {
    const before = events.length;
    let settled = false;
    const promise: Promise<unknown> = host.extensionUi(conversationId)[item.method](...args);
    void promise.then(() => { settled = true; });
    const request = events.slice(before).find((event) => event.type === "extension_ui_request")!;
    assert.ok(request);
    return { request, promise, settled: () => settled };
  }
  return {
    host, ask, events,
    pending: (): Request[] => host.getPendingUi(),
    reply: (id: string, response: Reply) => host.respondPermission({ id, ...response }),
    dismissals: () => events.filter((event) => event.type === "extension_ui_dismiss"),
  };
}

test("Vivi Workers park every blocking UI Promise and answer by original id without opening a session", async (t) => {
  const f = fixture(t);
  // No active session, catalog or session loader exists in this harness. Collection must
  // work directly from the host's pending map even for never-opened background Workers.
  const pending = cases.map((item, index) => f.ask(`vivi-worker-${index % 2}`, item));
  await flush();
  assert.ok(pending.every((entry) => !entry.settled()));
  assert.deepEqual(f.pending(), pending.map((entry) => entry.request));
  assert.equal(new Set(f.pending().map((request) => request.id)).size, cases.length);
  assert.equal(pending[3].request.prefill, "Original\nsummary");
  assert.deepEqual(pending[4].request.questions, questions);
  const remaining = new Set(pending.map((entry) => entry.request.id));
  // Answer out of queue order, including two requests belonging to the same Worker.
  for (const index of [3, 1, 4, 0, 2]) {
    const entry = pending[index];
    f.reply(entry.request.id, cases[index].reply);
    assert.deepEqual(await entry.promise, cases[index].expected);
    remaining.delete(entry.request.id);
    assert.deepEqual(new Set(f.pending().map((request) => request.id)), remaining);
    assert.deepEqual(f.dismissals().at(-1), {
      type: "extension_ui_dismiss", id: entry.request.id, conversationId: entry.request.conversationId,
    });
    f.reply(entry.request.id, { value: "duplicate", confirmed: true, answers: ["duplicate"] });
    await flush();
    for (const other of pending) if (remaining.has(other.request.id)) assert.equal(other.settled(), false);
  }
  assert.equal(f.dismissals().length, cases.length);
  const yes = f.ask("vivi-worker-yes", cases[0]);
  f.reply(yes.request.id, { confirmed: true });
  assert.equal(await yes.promise, true);
});

test("cancelled requests return fallbacks and late replies leave the next request waiting", async (t) => {
  const f = fixture(t);
  for (const item of cases) {
    const cancelled = f.ask("vivi-worker-a", item);
    f.reply(cancelled.request.id, { cancelled: true, ...item.reply });
    assert.equal(await cancelled.promise, item.fallback);
    const next = f.ask("vivi-worker-a", item);
    f.reply(cancelled.request.id, item.reply);
    await flush();
    assert.equal(next.settled(), false);
    assert.deepEqual(f.pending().map((request) => request.id), [next.request.id]);
    f.reply(next.request.id, item.reply);
    assert.deepEqual(await next.promise, item.expected);
  }
  assert.equal(f.dismissals().length, cases.length * 2);
});

test("timeouts dismiss only the expired id; late replies and cleared timers cannot settle its successor", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const f = fixture(t);
  const other = f.ask("vivi-worker-b", cases[3]);
  // Editor has no host timeout; the remaining four dialog APIs accept one.
  for (const item of cases.filter((entry) => entry.method !== "editor")) {
    const expiring = f.ask("vivi-worker-a", item, [...item.args, { timeout: 100 }]);
    t.mock.timers.tick(99);
    await flush();
    assert.equal(expiring.settled(), false);
    t.mock.timers.tick(1);
    assert.equal(await expiring.promise, item.fallback);
    const next = f.ask("vivi-worker-a", item, [...item.args, { timeout: 200 }]);
    f.reply(expiring.request.id, item.reply);
    await flush();
    assert.equal(next.settled(), false);
    assert.deepEqual(f.pending().map((request) => request.id), [other.request.id, next.request.id]);
    f.reply(next.request.id, item.reply);
    assert.deepEqual(await next.promise, item.expected);
    const dismissCount = f.dismissals().length;
    t.mock.timers.tick(200);
    assert.equal(f.dismissals().length, dismissCount, "answered timer must be cleared");
    assert.equal(other.settled(), false);
  }
  f.reply(other.request.id, { value: "" });
  assert.equal(await other.promise, "");
});

test("Worker Stop releases only that Worker's prompts and stale replies cannot answer a later turn", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const f = fixture(t);
  const stopped = cases.map((item) => f.ask("vivi-worker-a", item));
  const surviving = cases.map((item) => f.ask("vivi-worker-b", item));
  f.host.resolvePendingUi("vivi-worker-a"); // The production Stop path's prompt settlement.
  assert.deepEqual(await Promise.all(stopped.map((entry) => entry.promise)), cases.map((item) => item.fallback));
  const next = f.ask("vivi-worker-a", cases[4]);
  stopped.forEach((entry, index) => f.reply(entry.request.id, cases[index].reply));
  t.mock.timers.tick(1_000);
  await flush();
  assert.equal(next.settled(), false);
  assert.ok(surviving.every((entry) => !entry.settled()));
  assert.deepEqual(f.pending().map((request) => request.id), [...surviving, next].map((entry) => entry.request.id));
  assert.deepEqual(f.dismissals().map((request) => request.id), stopped.map((entry) => entry.request.id));
  f.reply(next.request.id, cases[4].reply);
  assert.deepEqual(await next.promise, cases[4].expected);
  // Application Stop settles all remaining Workers, with one dismissal per original id.
  f.host.resolvePendingUi();
  assert.deepEqual(await Promise.all(surviving.map((entry) => entry.promise)), cases.map((item) => item.fallback));
  t.mock.timers.tick(24 * 60 * 60_000);
  assert.equal(f.pending().length, 0);
  assert.equal(f.dismissals().length, stopped.length + surviving.length + 1);
});
