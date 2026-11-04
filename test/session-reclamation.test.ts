import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import { SubagentControl } from "../src/main/pi/subagent-control.ts";

// Exercise the actual reclamation predicates and both sweep paths without Electron.
const ts = createRequire(import.meta.url)("typescript") as typeof import("typescript");
const source = readFileSync(new URL("../src/main/pi/process-manager.ts", import.meta.url), "utf8");
const file = ts.createSourceFile("manager.ts", source, ts.ScriptTarget.Latest, true);
const methods: string[] = [];
function visit(node: import("typescript").Node): void {
  if (ts.isMethodDeclaration(node) && ["#releasableSession", "#sweepSessions"].includes(node.name.getText(file))) {
    methods.push(node.getText(file).replaceAll("#", ""));
  }
  ts.forEachChild(node, visit);
}
visit(file);
assert.equal(methods.length, 2);
const compiled = ts.transpileModule(`class Harness { ${methods.join("\n")} }`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText;
const Harness = new Function("SESSION_IDLE_MS", "MAX_RESIDENT_SESSIONS", `${compiled}; return Harness;`)(1_000, 1);

for (const expired of [true, false]) {
  test(`${expired ? "idle expiry" : "resident cap"} retains only parents with live child controls`, async () => {
    const host = new Harness();
    const sessions = new Map(["parent", "other", "active"].map((id) => [id, { session: { messages: [] } }]));
    const controls = new Map<string, SubagentControl>();
    const metadata = new Map([
      ["child", { id: "child", conversationId: "parent", status: "running" }],
      ["historical", { id: "historical", conversationId: "other", status: "completed" }],
    ]);
    const child = new SubagentControl(undefined, () => {});
    controls.set("child", child); // Still preparing: no SDK session bound yet.
    const released: string[] = [];
    let sweep: Promise<void> = Promise.resolve();
    Object.assign(host, {
      activeId: "active", sessions, subagents: metadata, subagentControls: controls,
      openingPrompts: new Map(), busy: () => false, sessionPromises: new Map(),
      drainingQueues: new Set(), messageQueue: { all: () => [] }, pendingUi: new Map(),
      catalog: { get: () => ({ sessionFile: "/fake/session.jsonl" }) },
      sessionTouched: new Map([...sessions.keys()].map((id) => [id, expired ? 0 : Date.now()])),
      queue: (run: () => Promise<void>) => (sweep = run()),
      releaseSession: async (id: string) => { released.push(id); sessions.delete(id); },
    });
    host.sweepSessions();
    await sweep;
    assert.deepEqual(released, ["other"], "another conversation and historical children do not pin sessions");
    assert.ok(sessions.has("parent"));

    // Abort does not imply finalization: keep the parent while the child unwinds.
    await child.abort();
    assert.equal(host.releasableSession("parent"), false);
    child.dispose();
    controls.delete("child"); // SubagentTurnRunner's terminal finally block.
    // Even stale running metadata cannot retain a completed runner indefinitely.
    host.sweepSessions();
    await sweep;
    assert.deepEqual(released, ["other", "parent"]);
    assert.deepEqual([...sessions.keys()], ["active"]);
  });
}
