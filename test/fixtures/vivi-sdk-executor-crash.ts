import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import { createFauxCore, fauxAssistantMessage, InMemoryModelsStore } from "@earendil-works/pi-ai";
import type { Policy } from "../../src/main/bot/core/ports.ts";
import { ShadowDriver } from "../../src/main/bot/shadow/driver.ts";
import { PiExecutor } from "../../src/main/bot/shadow/pi-executor.ts";
import { PiLedger } from "../../src/main/bot/shadow/pi-ledger.ts";
import { githubEventToTrigger } from "../../src/main/bot/shadow/github-source.ts";
import { openShadowStore } from "../../src/main/bot/shadow/store.ts";
import * as gh from "./vivi-github-http.ts";

// Offline, temporary-store crash harness. Explicit process.exit skips all host cleanup.
export const initialClock = 1_800_000_000_000;
export async function openCrashHost(root: string, options: { now?: number; crashAtProvider?: boolean; recipe?: ConstructorParameters<typeof PiExecutor>[0]["recipe"]; observeStop?: (completion: Promise<void>) => void } = {}) {
  const store = openShadowStore(join(root, "shadow.db"));
  let now = options.now ?? initialClock, autoSweep = false;
  const faux = createFauxCore({ api: "executor-crash-api", provider: "executor-crash", models: [{ id: "offline" }] });
  faux.setResponses(Array.from({ length: 12 }, () => () => {
    if (options.crashAtProvider) {
      const receipt = ledger.list(sessionKey())[0]!;
      assert.ok(receipt.entryId, "SDK user must be durable before provider factory starts");
      assert.equal(users().length, 1);
      writeFileSync(join(root, "provider-began.json"), JSON.stringify({ pid: process.pid, requestId: receipt.requestId, entryId: receipt.entryId }));
      process.exit(77);
    }
    return fauxAssistantMessage("offline recovery turn complete");
  }));
  const runtime = await ModelRuntime.create({ authPath: join(root, "faux-auth.json"), modelsPath: null,
    modelsStore: new InMemoryModelsStore(), allowModelNetwork: false, refreshOnCreate: false });
  runtime.registerProvider("executor-crash", { baseUrl: "http://faux.invalid", api: "executor-crash-api" as never, apiKey: "unused",
    streamSimple: faux.streamSimple as never, models: [{ id: "offline", name: "offline", reasoning: false, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100_000, maxTokens: 4096 }] });
  const policy: Policy = { version: "executor-crash-test", paused: false, evalTimeoutMs: 60_000,
    gate: () => ({ admissible: true, strength: "explicit", basis: { via: "listed" } }), revalidate: () => true, admitsInferred: () => true };
  let driver!: ShadowDriver;
  const executor = new PiExecutor({ store, root, engine: () => driver.engine, enabled: () => !driver.paused(), maxWorkers: () => 1,
    now: () => now, recipe: options.recipe, modelRuntime: runtime, model: runtime.getModel("executor-crash", "offline")! });
  driver = new ShadowDriver(store, { policy: () => policy, scope: { scope: () => ({ listened: true, observed: false }) },
    now: () => now, intervalMs: false, beforePass: () => autoSweep ? executor.sweep() : undefined },
  { ...executor.adapters, stop: async (control, context) => {
    const completion = executor.adapters.stop!(control, context); options.observeStop?.(completion); await completion;
  }, assessment: async () => {}, relay: async () => {}, notice: async () => {}, release: async () => {} });
  const ledger = new PiLedger(store);
  const ticketId = () => store.tickets.list()[0]!.id;
  const sessionKey = () => `worker-${ticketId()}`;
  const messages = (): { id: string; type: string; message?: { role: string; content: unknown } }[] =>
    readFileSync(ledger.session(sessionKey())!.sessionFile, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
  const users = () => messages().filter(row => row.type === "message" && row.message?.role === "user");
  return { store, driver, executor, ledger, faux, ticketId, sessionKey, messages, users,
    ticket: () => store.tickets.get(ticketId())!, tick: (ms: number) => { now += ms; },
    enableSweep: () => { autoSweep = true; },
    close: async () => { await driver.stop({ abort: true }); await executor.stop().catch(() => {}); store.close(); } };
}

async function crashChild(root: string, mode: string) {
  assert.ok(["prepared", "provider", "stopped", "user-only", "old-unsettled"].includes(mode));
  const h = await openCrashHost(root, { crashAtProvider: mode === "provider" });
  const issue = githubEventToTrigger({ type: "issues", issue: gh.issue, repository: gh.repository }, "github", "desktop", gh.config);
  h.driver.engine.sources.receive(issue); h.driver.engine.evaluateDue();
  const candidate = h.driver.engine.main.candidate(issue.id)!;
  const decision = h.driver.engine.main.decide(issue.id, { evalId: candidate.evalId, kind: "accept", title: "Crash recovery Issue", scope: "acme/widget", reason: "offline crash acceptance" });
  assert.ok(decision.ticketId);
  h.driver.engine.sources.bindThread(decision.ticketId, { source: "github", id: "acme/widget/pull/8" }, true);
  h.driver.start(); await h.driver.idle();
  const binding = h.driver.engine.currentBinding(h.ticketId())!; assert.ok(binding);
  h.tick(1);
  h.driver.engine.sources.receive({ ...issue, id: `${issue.id}:crash-follow`, at: new Date(initialClock + 1).toISOString(), text: "DURABLE_CRASH_FOLLOWUP" });
  await h.driver.idle();
  const receipt = h.ledger.list(h.sessionKey())[0]!;
  assert.equal(receipt.stage, "accepted"); assert.equal(receipt.entryId, undefined);
  assert.equal(h.store.effects.get("delivery", h.ticketId())?.status, "done");
  assert.deepEqual(h.ticket().undelivered, []); assert.equal(h.ticket().assignments.at(-1)?.state, "running");
  assert.equal(h.executor.slots.get(h.ticketId())?.phase, "starting");
  assert.equal(h.executor.record(h.ticketId())?.pid, process.pid);
  assert.equal(h.faux.state.callCount, 0); assert.equal(h.users().length, 0);
  writeFileSync(join(root, "crash.json"), JSON.stringify({ pid: process.pid, binding, receipt, slot: h.executor.slots.get(h.ticketId()) }));
  if (mode === "user-only") {
    // Crash after the original SDK disk append, before message_end/onPersisted can
    // reconcile SQLite. No ledger patch or synthetic user row simulates this gap.
    type Entry = { id: string; type: string; message?: { role: string } };
    const prototype = SessionManager.prototype as unknown as { _appendEntry(entry: Entry): void };
    const append = prototype._appendEntry;
    prototype._appendEntry = function (entry) {
      append.call(this, entry);
      if (entry.type !== "message" || entry.message?.role !== "user") return;
      assert.equal(h.users().length, 1);
      assert.equal(h.ledger.get(h.sessionKey(), receipt.requestId)!.entryId, undefined);
      assert.equal(h.faux.state.callCount, 0);
      writeFileSync(join(root, "user-appended.json"), JSON.stringify({ entryId: entry.id, requestId: receipt.requestId }));
      process.exit(78);
    };
    await h.executor.sweep(); await h.executor.idle();
    throw new Error("SDK disk append crash point was not reached");
  }
  if (mode === "old-unsettled") {
    // A historical role transcript entry must not classify the current accepted
    // binding as interrupted. Only fixture history is constructed here.
    const state = h.ledger.session(h.sessionKey())!;
    const oldBinding = { ...binding, assignmentId: `${binding.assignmentId}-previous`, generation: binding.generation + 10 };
    const old = h.ledger.accept({ sessionKey: h.sessionKey(), requestId: "historical-unsettled", text: "OLD_ASSIGNMENT_ONLY", inputIds: [], mode: "followUp", binding: oldBinding, epoch: state.epoch }).receipt;
    const manager = SessionManager.open(state.sessionFile, join(state.cwd, "../sessions"), state.cwd);
    const entryId = manager.appendMessage({ role: "user", content: [{ type: "text", text: old.text }], timestamp: initialClock,
      __fastvibeVivi: { version: 1, sessionKey: h.sessionKey(), requestId: old.requestId, epoch: state.epoch, binding: oldBinding } } as Parameters<typeof manager.appendMessage>[0]);
    h.ledger.patch(h.sessionKey(), old.requestId, { stage: "persisted", status: "uncertain", entryId, entryEpoch: state.epoch, entryBinding: oldBinding });
    assert.equal(h.users().length, 1); assert.equal(h.faux.state.callCount, 0);
  }
  if (mode === "provider") {
    await h.executor.sweep(); await h.executor.idle();
    throw new Error("Provider crash point was not reached");
  }
  if (mode === "stopped") {
    h.driver.engine.people.stopTicket(h.ticketId(), "Stop committed before crash");
    await h.driver.idle();
    assert.equal(h.ticket().ended?.outcome, "stopped");
    assert.equal(h.executor.record(h.ticketId())?.state, "stopped");
    assert.equal(h.ledger.list(h.sessionKey())[0]!.status, "stopped");
  }
  process.exit(76);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const root = process.argv[2], mode = process.argv[3]; assert.ok(root); assert.ok(mode);
  await crashChild(root, mode);
}
