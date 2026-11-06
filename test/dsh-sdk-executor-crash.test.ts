import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { WorkerToken } from "../src/main/bot/shadow/engine.ts";
import type { PiReceipt } from "../src/main/bot/shadow/pi-ledger.ts";
import type { SlotReservation } from "../src/main/bot/shadow/worker-slots.ts";
import { initialClock, openCrashHost } from "./fixtures/dsh-sdk-executor-crash.ts";

// Each child uses the actual Driver + Executor + SDK, commits SQLite, then exits
// without dispose/close. No provider network or production credentials are used.
const timeout = { timeout: 30_000 };
type Crash = { pid: number; binding: WorkerToken; receipt: PiReceipt; slot: SlotReservation };
async function restart(t: TestContext, mode: "prepared" | "provider" | "stopped" | "user-only" | "old-unsettled", expired = true) {
  const root = mkdtempSync(join(tmpdir(), "dsh-executor-crash-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const child = spawnSync(process.execPath, [fileURLToPath(new URL("./fixtures/dsh-sdk-executor-crash.ts", import.meta.url)), root, mode],
    { encoding: "utf8", timeout: 20_000, env: { ...process.env, NODE_TEST_CONTEXT: undefined } });
  assert.equal(child.error, undefined);
  assert.equal(child.signal, null);
  assert.equal(child.status, mode === "provider" ? 77 : mode === "user-only" ? 78 : 76, child.stderr + child.stdout);
  const crash = JSON.parse(readFileSync(join(root, "crash.json"), "utf8")) as Crash;
  assert.throws(() => process.kill(crash.pid, 0), (error: NodeJS.ErrnoException) => error.code === "ESRCH");
  const h = await openCrashHost(root, { now: initialClock + (expired ? 60_002 : 2) });
  t.after(h.close);
  assert.equal(h.ticketId(), crash.binding.ticketId);
  assert.equal(h.faux.state.callCount, 0);
  return { ...h, root, crash };
}

test("delivery-committed prepared inbox survives child exit76; quiet reconciliation resumes same binding exactly once", timeout, async t => {
  const h = await restart(t, "prepared", false);
  assert.deepEqual(h.driver.engine.currentBinding(h.ticketId()), h.crash.binding);
  assert.deepEqual(h.ledger.get(h.sessionKey(), h.crash.receipt.requestId), h.crash.receipt);
  assert.equal(h.executor.record(h.ticketId())?.pid, h.crash.pid);
  assert.equal(h.executor.slots.get(h.ticketId())?.phase, "starting");
  assert.equal(h.users().length, 0);
  assert.throws(() => h.executor.reconcile(h.ticketId(), { quiet: true }), /expiry/,
    "dead PID alone cannot free an unexpired slot");
  assert.deepEqual(h.executor.slots.get(h.ticketId()), h.crash.slot);
  assert.equal(h.faux.state.callCount, 0);
  h.tick(60_001);
  await h.executor.sweep(); await h.executor.idle();
  assert.equal(h.executor.record(h.ticketId())?.state, "uncertain");
  assert.equal(h.faux.state.callCount, 0); assert.equal(h.users().length, 0);
  assert.equal(h.executor.slots.used(), 1); assert.equal(h.executor.slots.get(h.ticketId())?.phase, "uncertain");
  await h.executor.sweep(); assert.equal(h.faux.state.callCount, 0);
  h.executor.reconcile(h.ticketId(), { quiet: true });
  assert.equal(h.executor.slots.get(h.ticketId()), undefined);
  assert.equal(h.executor.record(h.ticketId())?.state, "opened");
  assert.deepEqual(h.driver.engine.currentBinding(h.ticketId()), h.crash.binding);
  h.enableSweep(); h.driver.start(); await h.driver.idle(); await h.executor.idle();
  await Promise.all([h.executor.sweep(), h.executor.sweep()]); await h.executor.idle();
  assert.equal(h.faux.state.callCount, 1); assert.equal(h.users().length, 1);
  assert.equal(h.ticket().assignments.length, 1);
  const receipt = h.ledger.get(h.sessionKey(), h.crash.receipt.requestId)!;
  assert.ok(receipt.entryId); assert.equal(receipt.status, "settled"); assert.deepEqual(receipt.entryBinding, h.crash.binding);
  assert.equal(h.ledger.list(h.sessionKey()).length, 1); assert.equal(h.executor.slots.used(), 0);
  assert.ok(h.ticket().inputs.some(input => input.kind === "trigger" && input.deliveredTo === h.crash.binding.assignmentId && input.readAt));
});

test("provider-begun child exit77 stays uncertain until explicit interruption creates a new Assignment and recovery delivery", timeout, async t => {
  const h = await restart(t, "provider");
  const began = JSON.parse(readFileSync(join(h.root, "provider-began.json"), "utf8")) as { pid: number; requestId: string; entryId: string };
  assert.equal(began.pid, h.crash.pid); assert.equal(began.requestId, h.crash.receipt.requestId);
  const old = h.ledger.get(h.sessionKey(), began.requestId)!;
  assert.equal(old.entryId, began.entryId); assert.equal(h.users().length, 1);
  assert.equal(h.executor.slots.get(h.ticketId())?.phase, "running");
  const originalUser = h.users()[0]!, oldReads = structuredClone(old.reads);
  await h.executor.sweep(); await h.executor.sweep(); await h.executor.idle();
  assert.equal(h.executor.record(h.ticketId())?.state, "uncertain");
  assert.equal(h.faux.state.callCount, 0); assert.equal(h.users().length, 1); assert.equal(h.ticket().assignments.length, 1);
  h.executor.reconcile(h.ticketId(), { quiet: true });
  assert.equal(h.ticket().assignments.length, 2);
  assert.equal(h.ticket().assignments[0]!.state, "ended");
  assert.notEqual(h.ticket().assignments.at(-1)!.id, h.crash.binding.assignmentId);
  assert.match(JSON.stringify(h.ticket().inputs), /The host restarted during this ticket\. Inspect the current worktree/);
  assert.equal(h.faux.state.callCount, 0); assert.deepEqual(h.users(), [originalUser]);
  h.driver.start(); await h.driver.idle();
  if (!h.driver.engine.currentBinding(h.ticketId())) { h.tick(5_001); await h.driver.idle(); }
  const current = h.driver.engine.currentBinding(h.ticketId())!;
  assert.ok(current, JSON.stringify(h.store.effects.get("launch", h.ticket().assignments.at(-1)!.id)));
  assert.notEqual(current.assignmentId, h.crash.binding.assignmentId);
  assert.equal(h.faux.state.callCount, 0);
  h.enableSweep(); await h.driver.idle(); await h.executor.sweep(); await h.executor.idle();
  assert.equal(h.faux.state.callCount, 1);
  assert.equal(h.users().filter(row => row.id === originalUser.id).length, 1);
  assert.equal(h.users().length, 2);
  assert.deepEqual(h.ledger.get(h.sessionKey(), began.requestId)!.reads, oldReads);
  assert.equal(h.ledger.get(h.sessionKey(), began.requestId)!.entryId, began.entryId);
  const recovered = h.ledger.list(h.sessionKey()).filter(receipt => receipt.binding.assignmentId === current.assignmentId);
  assert.equal(recovered.length, 1); assert.notEqual(recovered[0]!.requestId, began.requestId);
  assert.equal(recovered[0]!.status, "settled"); assert.deepEqual(recovered[0]!.entryBinding, current);
  assert.match(recovered[0]!.text, /The host restarted during this ticket\. Inspect the current worktree/);
  assert.equal(h.ticket().assignments.length, 2);
  await h.executor.sweep(); await h.executor.idle(); assert.equal(h.faux.state.callCount, 1);
});

test("JSONL user written before receipt entryId crash recovers as interruption through disk-only reconciliation", timeout, async t => {
  const h = await restart(t, "user-only");
  const appended = JSON.parse(readFileSync(join(h.root, "user-appended.json"), "utf8")) as { entryId: string; requestId: string };
  const old = h.ledger.get(h.sessionKey(), appended.requestId)!;
  assert.equal(old.entryId, undefined); assert.equal(old.stage, "accepted");
  assert.equal(h.users().length, 1); const originalUser = h.users()[0]!;
  assert.equal(originalUser.id, appended.entryId);
  await h.executor.sweep(); await h.executor.idle();
  assert.equal(h.executor.record(h.ticketId())?.state, "uncertain"); assert.equal(h.faux.state.callCount, 0);
  const savedSession = h.ledger.session(h.sessionKey())!;
  h.executor.reconcile(h.ticketId(), { quiet: true });
  const reconciled = h.ledger.get(h.sessionKey(), old.requestId)!;
  assert.equal(reconciled.entryId, appended.entryId, "quiet recovery must first import the durable JSONL user identity");
  assert.deepEqual(reconciled.entryBinding, h.crash.binding);
  assert.deepEqual(h.ledger.session(h.sessionKey()), savedSession, "disk-only reconciliation must not reopen SDK or advance Session epoch");
  assert.equal(h.store.get<{ pid: number }>(`pi:owner:${h.sessionKey()}`)?.pid, h.crash.pid);
  assert.equal(h.ticket().assignments.length, 2, "persisted user requires new Assignment, never an accepted-inbox hang");
  assert.match(JSON.stringify(h.ticket().inputs), /The host restarted during this ticket\. Inspect the current worktree/);
  assert.equal(h.faux.state.callCount, 0); assert.deepEqual(h.users(), [originalUser]);
  h.driver.start(); await h.driver.idle();
  if (!h.driver.engine.currentBinding(h.ticketId())) { h.tick(5_001); await h.driver.idle(); }
  const binding = h.driver.engine.currentBinding(h.ticketId())!; assert.ok(binding); assert.notEqual(binding.assignmentId, h.crash.binding.assignmentId);
  h.enableSweep(); await h.driver.idle(); await h.executor.sweep(); await h.executor.idle();
  assert.equal(h.faux.state.callCount, 1); assert.equal(h.users().length, 2);
  assert.equal(h.users().filter(row => row.id === originalUser.id).length, 1);
  assert.deepEqual(h.ledger.get(h.sessionKey(), old.requestId)!.reads, []);
  assert.ok(h.ledger.list(h.sessionKey()).some(receipt => receipt.binding.assignmentId === binding.assignmentId && receipt.status === "settled"));
});

test("historical unsettled user cannot interrupt a current binding with only accepted inbox during quiet recovery", timeout, async t => {
  const h = await restart(t, "old-unsettled");
  const historical = h.ledger.get(h.sessionKey(), "historical-unsettled")!;
  assert.ok(historical.entryId); assert.notEqual(historical.entryBinding!.assignmentId, h.crash.binding.assignmentId);
  assert.equal(h.ledger.get(h.sessionKey(), h.crash.receipt.requestId)!.entryId, undefined);
  const originalUser = h.users()[0]!;
  await h.executor.sweep(); await h.executor.idle();
  assert.equal(h.executor.record(h.ticketId())?.state, "uncertain"); assert.equal(h.faux.state.callCount, 0);
  h.executor.reconcile(h.ticketId(), { quiet: true });
  assert.equal(h.ticket().assignments.length, 1, "old entryBinding must not restart the current Assignment");
  assert.deepEqual(h.driver.engine.currentBinding(h.ticketId()), h.crash.binding);
  assert.equal(h.executor.record(h.ticketId())?.state, "opened");
  assert.doesNotMatch(JSON.stringify(h.ticket().inputs), /The host restarted during this ticket/);
  h.enableSweep(); h.driver.start(); await h.driver.idle(); await h.executor.sweep(); await h.executor.idle();
  assert.equal(h.faux.state.callCount, 1); assert.equal(h.users().length, 2);
  assert.equal(h.users().filter(row => row.id === originalUser.id).length, 1);
  assert.deepEqual(h.ledger.get(h.sessionKey(), historical.requestId)!.reads, []);
  assert.equal(h.ledger.get(h.sessionKey(), h.crash.receipt.requestId)!.status, "settled");
  assert.equal(h.ticket().assignments.length, 1); assert.equal(h.executor.slots.used(), 0);
});

test("Stop committed before child exit remains terminal after reopen and cannot reactivate the old prepared request", timeout, async t => {
  const h = await restart(t, "stopped");
  assert.equal(h.ticket().ended?.outcome, "stopped"); assert.equal(h.driver.engine.currentBinding(h.ticketId()), undefined);
  assert.equal(h.executor.record(h.ticketId())?.state, "stopped");
  const old = h.ledger.get(h.sessionKey(), h.crash.receipt.requestId)!;
  assert.equal(old.status, "stopped"); assert.equal(old.entryId, undefined);
  assert.equal(h.executor.slots.used(), 0);
  h.enableSweep(); h.driver.start(); await h.driver.idle();
  await h.executor.sweep(); await h.executor.idle();
  assert.equal(h.faux.state.callCount, 0); assert.equal(h.users().length, 0);
  assert.equal(h.ticket().assignments.length, 1); assert.equal(h.ticket().ended?.outcome, "stopped");
  assert.equal(h.ledger.get(h.sessionKey(), old.requestId)!.status, "stopped");
  assert.equal(h.executor.slots.used(), 0);
});
