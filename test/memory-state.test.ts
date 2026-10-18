import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MemoryStateStore } from "../src/main/engine/memory-state.ts";
import { emptyState, type Failure, type MemoryStateFile, type Stage1Output } from "../src/main/engine/memory-plan.ts";
import { openTestDb, openSecondTestDb, spyDb, testDir } from "./test-db.ts";

/**
 * The memory pipeline's ledger: which conversations have been distilled at which transcript
 * mtime, which were read and found to hold nothing, which failed and when to try again.
 *
 * It was one 295 KB JSON file rewritten whole on a 500 ms debounce, so a pass that touched
 * one conversation rewrote all of them. These cases pin the ledger across a restart, the
 * import of that file, and 「清除」 reaching the rows rather than only the in-memory copy.
 */

const output = (id: string): Stage1Output => ({
  conversationId: id,
  cwd: "/work/app",
  rolloutPath: `/sessions/${id}.jsonl`,
  createdAt: 1_700_000_000_000,
  sourceUpdatedAt: 111,
  generatedAt: 222,
  rawMemory: "# Build\n- 用 pnpm",
  rolloutSummary: "改了并行构建",
  slug: "parallel-build",
  usageCount: 2,
  lastUsage: 999,
});

const failure = (): Failure => ({ sourceUpdatedAt: 333, attempts: 1, retryAfter: 555 });

const ledger = (): MemoryStateFile => ({
  ...emptyState(),
  outputs: { c1: output("c1") },
  empty: { c2: 222 },
  failures: { c3: failure() },
});

test("the ledger round-trips through the tables", () => {
  const dir = testDir("fastvibe-memory-state-");
  const store = new MemoryStateStore(openTestDb(dir));
  const source = ledger();
  store.save(source);
  assert.deepEqual(new MemoryStateStore(openTestDb(dir)).load(), source);
});

test("absent fields stay absent instead of becoming nulls", () => {
  const dir = testDir("fastvibe-memory-state-");
  const store = new MemoryStateStore(openTestDb(dir));
  store.save({ ...emptyState(), lastRunAt: 1234 });
  const loaded = new MemoryStateStore(openTestDb(dir)).load();
  assert.equal(loaded.lastRunAt, 1234);
  assert.equal("error" in loaded, false);

  store.save({ ...emptyState(), error: "boom" });
  const again = new MemoryStateStore(openTestDb(dir)).load();
  assert.equal(again.error, "boom");
  assert.equal("lastRunAt" in again, false, "a field the state no longer has is dropped from the table");
});

test("clearing removes every row, not just the memory of them", () => {
  const dir = testDir("fastvibe-memory-state-");
  const store = new MemoryStateStore(openTestDb(dir));
  store.save({ ...ledger(), lastRunAt: 7, error: "上一轮失败了" });
  store.clear();
  const db = openTestDb(dir);
  assert.equal(db.countRows("memory_outputs"), 0);
  assert.equal(db.countRows("memory_empty"), 0);
  assert.equal(db.countRows("memory_failures"), 0);
  assert.equal(db.countRows("memory_meta"), 0);
  assert.deepEqual(new MemoryStateStore(db).load(), emptyState());
});

test("a conversation that leaves a map leaves the table, and a changed one is rewritten", () => {
  const dir = testDir("fastvibe-memory-state-");
  const store = new MemoryStateStore(openTestDb(dir));
  store.save(ledger());
  const trimmed = ledger();
  delete trimmed.outputs.c1;
  trimmed.failures.c3 = { ...trimmed.failures.c3, attempts: 2 };
  store.save(trimmed);
  const loaded = store.load();
  assert.deepEqual(Object.keys(loaded.outputs), []);
  assert.equal(loaded.failures.c3.attempts, 2);
  assert.equal(loaded.empty.c2, 222);
  assert.deepEqual(openTestDb(dir).all<{ conversation_id: string }>("SELECT conversation_id FROM memory_outputs"), []);
});

test("a store that just read the ledger does not rewrite it", () => {
  const dir = testDir("fastvibe-memory-state-");
  const first = new MemoryStateStore(openTestDb(dir));
  const source = { ...ledger(), lastRunAt: 7 };
  first.save(source);

  const seen = spyDb(openTestDb(dir));
  const reopened = new MemoryStateStore(seen.proxy);
  const loaded = reopened.load();
  assert.deepEqual(seen.statements.filter((sql) => sql.includes("INSERT")), [], "loading primes, it does not write");
  reopened.save(loaded);
  assert.deepEqual(seen.statements.filter((sql) => sql.includes("INSERT") || sql.includes("DELETE")), [], "an unchanged save is silent");
  // One conversation's usage tick is one row, not the whole ledger.
  reopened.save({ ...loaded, outputs: { c1: { ...loaded.outputs.c1, usageCount: 3 } } });
  const inserts = seen.statements.filter((sql) => sql.includes("INSERT INTO memory_"));
  assert.equal(inserts.length, 1, inserts.join("\n"));
  assert.match(inserts[0], /memory_outputs/);
});

test("the legacy memory-state.json is imported once and kept under a new name", () => {
  const dir = testDir("fastvibe-memory-state-");
  const file = join(dir, "memory-state.json");
  const legacy = {
    version: 1,
    outputs: { c1: output("c1") },
    empty: { c2: 6 },
    failures: { c3: failure() },
    lastRunAt: 7,
    error: "上一轮整合失败了",
  };
  writeFileSync(file, JSON.stringify(legacy), "utf8");

  const store = new MemoryStateStore(openTestDb(dir), { legacyFile: file });
  assert.deepEqual(store.load(), legacy as unknown as MemoryStateFile);
  assert.ok(!existsSync(file));
  const kept = readdirSync(dir).filter((name) => name.startsWith("memory-state.json.migrated-"));
  assert.equal(kept.length, 1, readdirSync(dir).join(","));
  assert.equal(openTestDb(dir).get<{ status: string }>("SELECT status FROM legacy_imports WHERE name = 'memory-state'")?.status, "imported");

  // The import is a one-time act: a file that turns up again is renamed aside, not merged.
  writeFileSync(file, JSON.stringify({ version: 1, outputs: { late: output("late") } }), "utf8");
  const late = new MemoryStateStore(openTestDb(dir), { legacyFile: file });
  assert.equal(late.load().outputs.late, undefined);
  assert.ok(!existsSync(file), "the orphaned file was moved out of the way");
});

test("a legacy file of another version is not a state", () => {
  const dir = testDir("fastvibe-memory-state-");
  const file = join(dir, "memory-state.json");
  writeFileSync(file, JSON.stringify({ version: 2, outputs: { c1: {} } }), "utf8");
  const store = new MemoryStateStore(openTestDb(dir), { legacyFile: file });
  // The old reader's own rule: a version it does not know is no state at all, and the file
  // was readable, so this is an import that landed on nothing — not a corrupt file.
  assert.deepEqual(store.load(), emptyState());
  assert.ok(!existsSync(file));
  assert.equal(readdirSync(dir).filter((name) => name.startsWith("memory-state.json.migrated-")).length, 1);
});

test("a corrupt legacy file is kept for a human and the ledger starts empty", () => {
  const dir = testDir("fastvibe-memory-state-");
  const file = join(dir, "memory-state.json");
  writeFileSync(file, "{ nope", "utf8");
  const store = new MemoryStateStore(openTestDb(dir), { legacyFile: file });
  assert.deepEqual(store.load(), emptyState());
  assert.ok(readdirSync(dir).some((name) => name.startsWith("memory-state.json.corrupt-")), readdirSync(dir).join(","));
  assert.equal(readFileSync(join(dir, readdirSync(dir).find((name) => name.includes("corrupt-")!)!), "utf8"), "{ nope");
});

test("the second process reads what the first wrote, and prunes a row it does not need", () => {
  const dir = testDir("fastvibe-memory-state-");
  new MemoryStateStore(openTestDb(dir)).save(ledger());
  const other = openSecondTestDb(dir);
  const second = new MemoryStateStore(other);
  assert.equal(second.load().outputs.c1.sourceUpdatedAt, 111);
  // `#prune` dropping a conversation is a DELETE of that row; the first process sees it.
  second.save({ ...emptyState(), outputs: {} });
  assert.deepEqual(new MemoryStateStore(openTestDb(dir)).load().outputs, {});
  other.close();
});
