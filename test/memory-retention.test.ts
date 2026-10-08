import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { MemoryStore } from "../src/main/engine/memory-store.ts";
import { DEFAULT_MEMORY_CONFIG, memoryConfigOf, type MemoryItem } from "../src/shared/memory.ts";
import { MEMORY_DAY_MS as DAY, MEMORY_MAINTENANCE_BATCH } from "../src/main/engine/memory-retention.ts";
import type { ConsolidationDecision } from "../src/main/engine/memory-jev.ts";

const NOW = 200 * DAY;
function fixture(t: Parameters<Parameters<typeof test>[1]>[0]) {
  const dir = mkdtempSync(join(tmpdir(), "fastvibe-retention-"));
  const path = join(dir, "memory.sqlite");
  const store = new MemoryStore(path);
  const seed = (id: string, patch: Partial<MemoryItem> = {}) => {
    const item: MemoryItem = { id, role: "assistant", kind: "episode", project: "project", conversationId: "chat", content: `Memory ${id} 深色模式`, createdAt: DAY, importance: 0.5, confidence: 0.9, entities: ["FastVibe"], ...patch };
    store.upsert(item, [1, 0]);
    return item;
  };
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  return { store, seed, path };
}

test("temporary memories archive after inactivity; durable and recently used evidence survives", (t) => {
  const { store, seed } = fixture(t);
  seed("old");
  seed("recent", { createdAt: NOW - 89 * DAY });
  seed("used"); store.touch(["used"], NOW - DAY);
  seed("preference", { kind: "preference" });
  seed("procedure", { kind: "procedural" });
  seed("fact", { kind: "fact" });
  seed("semantic", { kind: "semantic" });
  seed("summary", { role: "summary" });
  seed("rule", { content: "以后都使用中文回复" });
  seed("explicit", { content: "Always use pnpm in this repository" });
  seed("overlapping", { typeScores: { episodic: 0.9, semantic: 0.1, preference: 0.7, procedural: 0 } });
  seed("pinned"); store.setPinned("pinned", true);
  const state = store.maintain(DEFAULT_MEMORY_CONFIG, NOW);
  assert.equal(state.archived, 1);
  assert.equal(state.active, 11);
  assert.equal(store.item("old")?.archiveReason, "expired");
  assert.equal(store.item("old")?.archivedAt, NOW);
  assert.equal(store.item("used")?.lastAccessedAt, NOW - DAY);
});

test("all retrieval paths exclude archived nodes, including CJK fallback and graph traversal", (t) => {
  const { store, seed } = fixture(t);
  seed("old"); seed("active", { createdAt: NOW });
  store.addEdge({ sourceId: "active", targetId: "old", view: "entity", relation: "same_entity", weight: 1 });
  store.maintain(DEFAULT_MEMORY_CONFIG, NOW);
  for (const items of [store.keyword("Memory", 10), store.keyword("深色", 10), store.embeddings(), store.recent(), store.byEntities(["FastVibe"])]) {
    assert.deepEqual(items.map((item) => item.id), ["active"]);
  }
  assert.deepEqual(store.neighbours(["active"]), []);
  assert.deepEqual(store.neighbours(["old"]), []);
  assert.deepEqual(store.neighboursOf("active"), []);
  assert.deepEqual(store.neighboursOf("old"), []);
  assert.equal(store.neighboursOf("old", { includeArchived: true }).length, 1);
  assert.deepEqual(store.graph(10).nodes.map((item) => item.id), ["active"]);
  assert.deepEqual(store.graph(10, "project", "archived").nodes.map((item) => item.id), ["old"]);
  assert.equal(store.hasItems({ conversationId: "missing" }), false);
  assert.equal(store.item("old")?.content, "Memory old 深色模式");
});

test("archive grace starts when archived, restore pins the memory, and purge removes FTS and edges", (t) => {
  const { store, seed, path } = fixture(t);
  const old = seed("old"); seed("restore"); seed("active", { createdAt: NOW });
  store.addEdge({ sourceId: "active", targetId: "old", view: "semantic", relation: "related", weight: 1 });
  store.maintain(DEFAULT_MEMORY_CONFIG, NOW);
  // Replayed capture cannot resurrect an archived row.
  store.upsert(old, [1, 0]);
  assert.equal(store.isActive("old"), false);
  store.restore("restore", NOW);
  assert.equal(store.item("restore")?.pinned, true);
  assert.equal(store.item("restore")?.archivedAt, undefined);
  assert.equal(store.maintain(DEFAULT_MEMORY_CONFIG, NOW + 29 * DAY).deletedLastRun, 0);
  assert.equal(store.maintain(DEFAULT_MEMORY_CONFIG, NOW + 30 * DAY).deletedLastRun, 1);
  assert.equal(store.item("old"), undefined);
  assert.equal(store.count().edges, 0);
  assert.equal(store.keyword("old", 10).length, 0);
  assert.equal(store.isActive("restore"), true);
  const db = new DatabaseSync(path);
  try { db.exec("INSERT INTO memory_fts(memory_fts, rank) VALUES ('integrity-check', 1)"); } finally { db.close(); }
});

test("exact deduplication preserves scope, speaker, code whitespace and the newest or pinned copy", (t) => {
  const { store, seed } = fixture(t);
  const common = { content: "Shared fact", kind: "fact" as const };
  seed("a", common); seed("b", { ...common, conversationId: "another", createdAt: NOW });
  seed("other-project", { ...common, project: "other" });
  seed("other-speaker", { ...common, role: "user" });
  seed("no-project-a", { ...common, project: undefined });
  seed("no-project-b", { ...common, project: undefined, conversationId: "another" });
  seed("whitespace", { ...common, content: "Shared  fact" });
  const state = store.maintain(DEFAULT_MEMORY_CONFIG, NOW);
  assert.equal(state.archived, 1);
  assert.equal(store.item("a")?.replacementId, "b");
  store.restore("a", NOW);
  store.maintain(DEFAULT_MEMORY_CONFIG, NOW);
  assert.equal(store.isActive("a"), true);
  assert.equal(store.item("b")?.replacementId, "a");
});

test("capacity evicts temporary low-value evidence and reports retained overflow without deleting it", (t) => {
  const { store, seed } = fixture(t);
  seed("valuable", { kind: "fact", createdAt: NOW, importance: 1 });
  seed("temporary", { createdAt: NOW, importance: 0.1 });
  seed("rule", { kind: "preference", createdAt: NOW });
  let state = store.maintain({ ...DEFAULT_MEMORY_CONFIG, maxActiveItems: 2 }, NOW);
  assert.equal(store.item("temporary")?.archiveReason, "capacity");
  assert.equal(state.active, 2);
  seed("retained", { kind: "procedural" });
  state = store.maintain({ ...DEFAULT_MEMORY_CONFIG, maxActiveItems: 1 }, NOW);
  assert.equal(state.active, 2);
  assert.equal(state.overBudget, 1);
  assert.equal(state.pending, false);
  assert.equal(store.isActive("rule"), true);
});

test("JEV archives only confident non-conflicting replacements in the same scope and chronological direction", (t) => {
  const { store, seed } = fixture(t);
  const decision = (candidateId: string, patch: Partial<ConsolidationDecision> = {}): ConsolidationDecision => ({ candidateId, redundant: 0, contradiction: 0, obsolete: 0.99, link: 1, representation: { choice: "keep_separate", probabilities: { keep_separate: 1 } }, ...patch });
  seed("source", { role: "user", createdAt: NOW });
  seed("old"); seed("uncertain"); seed("conflict"); seed("newer", { createdAt: NOW + 1 });
  seed("outside", { project: "other" }); seed("pinned"); store.setPinned("pinned", true);
  store.applyConsolidation("source", [decision("old"), decision("uncertain", { obsolete: 0.9 }), decision("conflict", { contradiction: 0.8 }), decision("newer"), decision("outside"), decision("pinned")], NOW);
  assert.equal(store.item("old")?.archiveReason, "superseded");
  assert.equal(store.item("old")?.replacementId, "source");
  assert.equal(store.maintenanceState(100).archived, 1);
  seed("assistant", { createdAt: NOW }); seed("user", { role: "user" });
  store.applyConsolidation("assistant", [decision("user")], NOW);
  assert.equal(store.isActive("user"), true);
});

test("maintenance can be disabled and large backlogs continue across reopen with atomic checkpoints", (t) => {
  const { store, seed, path } = fixture(t);
  for (let i = 0; i < MEMORY_MAINTENANCE_BATCH + 2; i++) seed(`old-${i}`);
  assert.equal(store.maintain({ ...DEFAULT_MEMORY_CONFIG, autoMaintain: false }, NOW).archived, 0);
  const first = store.maintain(DEFAULT_MEMORY_CONFIG, NOW);
  assert.equal(first.pending, true);
  assert.equal(first.archivedLastRun, MEMORY_MAINTENANCE_BATCH);
  const reopened = new MemoryStore(path);
  try {
    assert.equal(reopened.maintenanceState(10000).pending, true);
    const done = reopened.maintain(DEFAULT_MEMORY_CONFIG, NOW);
    assert.equal(done.pending, false);
    assert.equal(done.archivedLastRun, MEMORY_MAINTENANCE_BATCH + 2);
  } finally { reopened.close(); }
});

test("a failed purge rolls back both the canonical rows and FTS", (t) => {
  const { store, seed, path } = fixture(t);
  seed("old"); store.maintain(DEFAULT_MEMORY_CONFIG, NOW);
  const db = new DatabaseSync(path);
  try {
    db.exec("CREATE TRIGGER refuse_delete BEFORE DELETE ON memory_items BEGIN SELECT RAISE(ABORT, 'test rollback'); END;");
    assert.throws(() => store.maintain(DEFAULT_MEMORY_CONFIG, NOW + 30 * DAY), /test rollback/);
    assert.equal(store.item("old")?.archivedAt, NOW);
    assert.equal(store.maintenanceState(10000).lastRunAt, NOW);
    db.exec("INSERT INTO memory_fts(memory_fts, rank) VALUES ('integrity-check', 1)");
  } finally { db.close(); }
});

test("retention defaults migrate old settings and reject unsafe numeric bounds", () => {
  assert.equal(memoryConfigOf({ mode: "semantic" }).autoMaintain, true);
  const config = memoryConfigOf({ autoMaintain: false, temporaryRetentionDays: -10, archiveRetentionDays: 0, maxActiveItems: Infinity });
  assert.equal(config.autoMaintain, false);
  assert.equal(config.temporaryRetentionDays, 7);
  assert.equal(config.archiveRetentionDays, 7);
  assert.equal(config.maxActiveItems, 10000);
});

test("archive pagination can reach every recoverable memory with stable timestamp ties", (t) => {
  const { store, seed } = fixture(t);
  for (let i = 0; i < 7; i++) seed(`old-${i}`);
  store.maintain(DEFAULT_MEMORY_CONFIG, NOW);
  const ids = [0, 3, 6].flatMap((offset) => store.graph(3, "project", "archived", offset).nodes.map((item) => item.id));
  assert.equal(ids.length, 7);
  assert.equal(new Set(ids).size, 7);
  store.restore(ids[6], NOW);
  assert.equal(store.graph(3, "project", "archived").total, 6);
  assert.equal(store.graph(3).total, 1);
});

test("an old database gains lifecycle columns and protects existing standing rules without archiving on open", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "fastvibe-retention-migration-"));
  const path = join(dir, "memory.sqlite");
  const legacy = new DatabaseSync(path);
  legacy.exec(`CREATE TABLE memory_items (id TEXT PRIMARY KEY, conversation_id TEXT, project TEXT, role TEXT NOT NULL, kind TEXT NOT NULL,
    content TEXT NOT NULL, created_at INTEGER NOT NULL, importance REAL NOT NULL DEFAULT 0.5, confidence REAL NOT NULL DEFAULT 0.5,
    source_entry_id TEXT, metadata TEXT, type_scores TEXT, entities TEXT, embedding BLOB, embedding_dim INTEGER);
    INSERT INTO memory_items(id, role, kind, content, created_at) VALUES ('rule', 'user', 'episode', 'Always use pnpm', 1), ('old', 'assistant', 'episode', 'Deployment finished', 2);`);
  legacy.close();
  const store = new MemoryStore(path);
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  assert.equal(store.maintenanceState(10000).active, 2);
  assert.equal(store.maintain(DEFAULT_MEMORY_CONFIG, NOW).archived, 1);
  assert.equal(store.isActive("rule"), true);
});
