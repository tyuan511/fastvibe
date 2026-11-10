import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { openShadowStore } from "../src/main/bot/shadow/store.ts";
import { ExecutionDirectories, executionPaths } from "../src/main/bot/shadow/execution-directory.ts";

const token = { ticketId: "ticket-dir", assignmentId: "assignment", generation: 1, claimToken: 1 };
function fixture(t: test.TestContext) { const root = mkdtempSync(join(tmpdir(), "vivi-dir-")); const store = openShadowStore(":memory:"); t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); }); return { root, store, dirs: new ExecutionDirectories(store, root, { leaseMs: 5_000, prepareTimeoutMs: 100 }) }; }

test("executionPaths is stable and matches the Pi scratch layout", t => { const f = fixture(t); const a = executionPaths(f.root, token.ticketId); const b = executionPaths(f.root, token.ticketId); assert.deepEqual(a, b); assert.equal(a.sessionFile, join(a.sessionDir, `${createHash("sha256").update(`worker-${token.ticketId}`).digest("hex")}.jsonl`)); });

test("empty directory without a recipe becomes ready and is reused", async t => { const f = fixture(t); const first = await f.dirs.prepare(token.ticketId); assert.equal(first.state, "ready"); assert.equal(f.dirs.get(token.ticketId)?.revision, first.revision); const second = await f.dirs.prepare(token.ticketId); assert.equal(second.revision, first.revision); });

test("recipe runs once, persists metadata, and recipe identity is fixed", async t => { const f = fixture(t); let calls = 0; const recipe = { id: "prepare-v1", run: async ({ cwd }: { cwd: string }) => { calls++; writeFileSync(join(cwd, "prepared.txt"), "ok"); return { branch: "main" }; } }; const first = await f.dirs.prepare(token.ticketId, { recipe }); assert.equal(first.state, "ready"); assert.equal(first.metadata?.branch, "main"); assert.equal(calls, 1); await assert.rejects(f.dirs.prepare(token.ticketId, { recipe: { ...recipe, id: "prepare-v2" } }), /immutable/); });

test("failed non-empty prepare requires explicit reconciliation", async t => { const f = fixture(t); await assert.rejects(f.dirs.prepare(token.ticketId, { recipe: { id: "bad", run: async ({ cwd }) => { writeFileSync(join(cwd, "partial"), "x"); throw new Error("prepare failed"); } } }), /prepare failed/); const failed = f.dirs.get(token.ticketId)!; assert.equal(failed.state, "failed"); assert.throws(() => f.dirs.retry(token.ticketId, failed.revision), /failed empty/); const ready = f.dirs.reconcile(token.ticketId, failed.revision, { prepared: false }); assert.equal(ready.state, "failed"); });

test("expired preparing lease becomes uncertain and cannot auto rerun", async t => { let now = 0; const f = fixture(t); const dirs = new ExecutionDirectories(f.store, f.root, { now: () => now, leaseMs: 10, prepareTimeoutMs: 100 }); const promise = dirs.prepare(token.ticketId, { recipe: { id: "wait", run: async () => { await new Promise<void>(() => {}); } } }); await new Promise(resolve => setImmediate(resolve)); now = 20; await assert.rejects(dirs.prepare(token.ticketId), /reconciliation/); void promise.catch(() => {}); });

test("symlinked execution base is rejected", async t => { const f = fixture(t); const p = executionPaths(f.root, token.ticketId); mkdirSync(p.base, { recursive: true }); const outside = mkdtempSync(join(tmpdir(), "vivi-out-")); rmSync(p.base, { recursive: true, force: true }); symlinkSync(outside, p.base); await assert.rejects(f.dirs.prepare(token.ticketId), /symbolic|Shadow/); rmSync(outside, { recursive: true, force: true }); });
