import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import { SubagentControl } from "../src/main/pi/subagent-control.ts";

// Exercise Main's real Stop path without Electron or paid provider requests.
const ts = createRequire(import.meta.url)("typescript") as typeof import("typescript");
const source = readFileSync(new URL("../src/main/pi/process-manager.ts", import.meta.url), "utf8");
const file = ts.createSourceFile("manager.ts", source, ts.ScriptTarget.Latest, true);
const methods: string[] = [];
function visit(node: import("typescript").Node): void {
  if (ts.isMethodDeclaration(node) && ["abort", "#abortOwnedSubagents", "abortSubagent"].includes(node.name.getText(file))) {
    methods.push(node.getText(file).replaceAll("#", ""));
  }
  ts.forEachChild(node, visit);
}
visit(file);
assert.equal(methods.length, 3);
const compiled = ts.transpileModule(`class Harness { ${methods.join("\n")} }`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText;
const Harness = new Function("uiText", `${compiled}; return Harness;`)((zh: string) => zh);

function fixture(parentAbort: () => Promise<void> = async () => {}) {
  const host = new Harness();
  const stopped: string[] = [];
  const released: string[] = [];
  const subagents = new Map();
  const controls = new Map<string, SubagentControl>();
  Object.assign(host, {
    activeId: "a", cwd: "/fake", subagents, subagentControls: controls, stoppedSubagents: new Set(),
    promptPreparations: { cancel() {} }, bumpQueueEpoch() {},
    withQueue: async (_id: string, run: () => Promise<void>) => run(),
    sdkQueueAdapters: new Map(),
    messageQueue: { restorePending() {} },
    interruptedRuns: new Map(), emitQueue() {}, resolvePendingUi() {},
    isLive: () => false, setStatus() {},
    sessionFor: async () => ({ session: { clearQueue() {}, abort: async () => { stopped.push("parent"); await parentAbort(); } } }),
  });
  function child(id: string, owner: string, abort: () => Promise<void> = async () => {}) {
    const control = new SubagentControl(undefined, () => released.push(id));
    control.bind({ abort: async () => { stopped.push(id); await abort(); } });
    controls.set(id, control);
    subagents.set(id, { id, conversationId: owner, status: "running" });
    return control;
  }
  return { host, child, stopped, released, controls };
}

for (const explicit of [true, false]) {
  test(`Stop ${explicit ? "by id" : "on the active chat"} cancels every owned child and leaves other chats running`, async () => {
    const f = fixture();
    const first = f.child("agent-first:turn:1", "a");
    const second = f.child("agent-second:turn:2", "a");
    const other = f.child("agent-other:turn:1", "b");
    // A historical run with no live control must not be treated as active work.
    f.host.subagents.set("finished", { id: "finished", conversationId: "a", status: "completed" });
    await f.host.abort(explicit ? "a" : undefined);
    assert.equal(first.aborted, true);
    assert.equal(second.aborted, true);
    assert.equal(other.aborted, false);
    assert.deepEqual(f.stopped.sort(), ["agent-first:turn:1", "agent-second:turn:2", "parent"]);
    assert.deepEqual(f.released.sort(), ["agent-first:turn:1", "agent-second:turn:2"]);
  });
}

test("Stop cancels a child still preparing its session", async () => {
  const f = fixture();
  const control = new SubagentControl(undefined, () => {});
  f.controls.set("preparing", control);
  f.host.subagents.set("preparing", { id: "preparing", conversationId: "a", status: "running" });
  await f.host.abort("a");
  assert.throws(() => control.check(), { name: "AbortError" });
});

test("a child stop failure still stops the parent and waits for all siblings", async () => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const f = fixture();
  f.child("failed", "a", async () => { throw new Error("child stop failed"); });
  f.child("held", "a", () => held);
  let returned = false;
  const stopped = f.host.abort("a").finally(() => { returned = true; });
  const rejected = assert.rejects(stopped, /child stop failed/);
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(f.stopped.includes("parent"));
  assert.equal(returned, false);
  release();
  await rejected;
});

test("a parent stop failure cannot leave its children running", async () => {
  const f = fixture(async () => { throw new Error("parent stop failed"); });
  const control = f.child("child", "a");
  await assert.rejects(f.host.abort("a"), /parent stop failed/);
  assert.equal(control.aborted, true);
});
