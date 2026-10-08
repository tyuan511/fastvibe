import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DagStore } from "../src/main/engine/dag-store.ts";
import { DagScheduler, type DagNodeRun } from "../src/main/pi/dag-scheduler.ts";

// Exercise the real engine shutdown method with no Electron or provider, as in subagent-run.test.ts.
const ts = createRequire(import.meta.url)("typescript") as typeof import("typescript");
const source = readFileSync(new URL("../src/main/pi/process-manager.ts", import.meta.url), "utf8");
const file = ts.createSourceFile("process-manager.ts", source, ts.ScriptTarget.Latest, true);
let method = "";
function visit(node: import("typescript").Node): void {
  if (ts.isMethodDeclaration(node) && node.name.getText(file) === "stop") method = node.getText(file);
  ts.forEachChild(node, visit);
}
visit(file);
assert.ok(method);
const compiled = ts.transpileModule(`class Harness { ${method.replaceAll("#", "")} }`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText;

test("engine stop suspends DAG work before waiting on its operation queue or tearing down the runtime", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "dag-shutdown-"));
  const store = new DagStore(join(dir, "dag.json"));
  t.after(() => { store.flush(); rmSync(dir, { recursive: true, force: true }); });
  const Harness = new Function("uiText", `${compiled}; return Harness;`)((zh: string) => zh);
  const host = new Harness();
  host.openingPrompts = new Map();
  for (const name of ["sessions", "sessionTouched", "sessionPromises", "pendingMcpReloads", "subagentControls", "oauthLogins", "widgetTimers", "busyBroadcast", "running", "compacting", "sdkQueueAdapters", "drainingQueues", "drainPromises", "preferredQueueIds", "queueRebuilds", "queueDrainFaults", "interruptedRuns", "timing", "runTouchedFiles", "extensionStatuses", "subagentSessions", "stoppedSubagents", "subagentReasoning", "reasoningRun"]) host[name] = new Map();
  let unlock!: () => void;
  const queue = new Promise<void>((resolve) => { unlock = resolve; });
  let preparationStopped = false;
  Object.assign(host, {
    promptPreparations: { cancel: () => { preparationStopped = true; } },
    runtime: {}, models: {}, status: { state: "ready" },
    queue: async (work: () => Promise<void>) => { await queue; await work(); },
    stopSessionSweep() {}, resolvePendingUi() {},
    messageQueue: { conversationIds: () => [] }, mcp: { close: async () => {} },
    setStatus(value: unknown) { this.status = value; },
  });
  let finish!: (value: DagNodeRun) => void;
  const runs: string[] = [];
  let cancelled = false;
  host.dagScheduler = new DagScheduler(store, async ({ node, signal }) => {
    runs.push(node.id);
    if (!host.runtime) return { status: "failed", output: "", error: "engine not ready" };
    signal.addEventListener("abort", () => { cancelled = true; });
    host.subagentControls.set(node.id, { abort: async () => { cancelled = true; } });
    return await new Promise<DagNodeRun>((resolve) => { finish = resolve; });
  }, { concurrency: 1 });
  host.dagScheduler.add("c1", ["a", "b"].map((title) => ({ title, instruction: title, profile: { name: "worker", instructions: "work" } })));
  const stopped = host.stop();
  assert.equal(preparationStopped, true, "memory preparation must stop before waiting on the operation queue");
  assert.equal(cancelled, true, "the operation queue must not delay cancellation");
  assert.equal(store.node("c1", "T-0002")?.status, "cancelled");
  unlock();
  await stopped;
  // Real SDK runners can take longer to exit than the engine's own teardown.
  finish({ status: "aborted", output: "" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(runs, ["T-0001"]);
  assert.deepEqual(store.get("c1")!.nodes.map((node) => node.status), ["cancelled", "cancelled"]);
});
