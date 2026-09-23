import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { MemoryStore } from "../src/main/engine/memory-store.ts";

test("memory store keeps FTS and graph edges in sync", async () => {
  const directory = await mkdtemp(join(tmpdir(), "fastvibe-memory-"));
  const store = new MemoryStore(join(directory, "memory.sqlite"));
  try {
    store.upsert({
      id: "a",
      role: "user",
      kind: "fact",
      content: "The user prefers dark mode",
      createdAt: 1,
      importance: 0.8,
      confidence: 1,
      typeScores: { episodic: 0.2, semantic: 0.9, procedural: 0.1, preference: 0.7 },
      entities: ["FastVibe"],
    });
    store.upsert({
      id: "b",
      role: "assistant",
      kind: "episode",
      content: "The dark mode preference was applied",
      createdAt: 2,
      importance: 0.5,
      confidence: 0.8,
    });
    store.addEdge({ sourceId: "b", targetId: "a", view: "semantic", relation: "supports", weight: 0.7 });
    store.addEdge({ sourceId: "b", targetId: "a", view: "temporal", relation: "after", weight: 0.6 });
    store.upsert({
      id: "c",
      role: "user",
      kind: "preference",
      content: "用户偏好深色模式",
      createdAt: 3,
      importance: 0.7,
      confidence: 0.9,
    });

    assert.deepEqual(store.keyword("dark mode", 8).map((item) => item.id).sort(), ["a", "b"]);
    assert.equal(store.keyword("深色", 8)[0]?.id, "c");
    assert.equal(store.count().edges, 2);
    assert.deepEqual(store.item("a")?.typeScores, { episodic: 0.2, semantic: 0.9, procedural: 0.1, preference: 0.7 });
    assert.deepEqual(store.item("a")?.entities, ["FastVibe"]);
    assert.equal(store.neighbours(["a"])[0]?.id, "b");

    // Outgoing edges first, then incoming, each in insertion order (`get_neighbors`).
    store.addEdge({ sourceId: "a", targetId: "c", view: "entity", relation: "same_entity", weight: 1 });
    assert.deepEqual(store.neighboursOf("a").map(({ item, edge }) => `${item.id}:${edge.view}:${edge.relation}`), ["c:entity:same_entity", "b:semantic:supports", "b:temporal:after"]);
    assert.deepEqual(store.neighboursOf("a", { project: "elsewhere" }), []);
    store.addEdge({ sourceId: "a", targetId: "c", view: "entity", relation: "same_entity", weight: 0.2 }, { ifAbsent: true });
    assert.equal(store.neighboursOf("a")[0].edge.weight, 1);

    store.setMetadata("b", { consolidationKey: "abc123" });
    assert.equal(store.hasMetadata("consolidationKey", "abc123"), true);
    assert.equal(store.hasMetadata("consolidationKey", "abc"), false);

    assert.equal(store.meta("jev_writes"), undefined);
    store.setMeta("jev_writes", "19");
    store.setMeta("jev_writes", "20");
    assert.equal(store.meta("jev_writes"), "20");

    store.delete("a");
    assert.deepEqual(store.count(), { items: 2, edges: 0 });
    store.upsert({ id: "k", role: "user", kind: "fact", content: "keywords", createdAt: 4, importance: 0.5, confidence: 0.5 }, undefined, ["alpha", "beta"]);
    assert.deepEqual(store.item("k")?.keywords, ["alpha", "beta"]);
    assert.equal(store.keyword("dark mode", 8)[0]?.id, "b");
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("edges of different origins between one pair coexist; an older table is migrated", async () => {
  const directory = await mkdtemp(join(tmpdir(), "fastvibe-memory-"));
  const file = join(directory, "memory.sqlite");
  const legacy = new DatabaseSync(file);
  legacy.exec(`
    CREATE TABLE memory_items (id TEXT PRIMARY KEY, conversation_id TEXT, project TEXT, role TEXT NOT NULL, kind TEXT NOT NULL,
      content TEXT NOT NULL, created_at INTEGER NOT NULL, importance REAL NOT NULL DEFAULT 0.5, confidence REAL NOT NULL DEFAULT 0.5,
      source_entry_id TEXT, metadata TEXT, type_scores TEXT, entities TEXT, embedding BLOB, embedding_dim INTEGER);
    CREATE TABLE memory_edges (source_id TEXT NOT NULL, target_id TEXT NOT NULL, view TEXT NOT NULL DEFAULT 'semantic', relation TEXT NOT NULL,
      weight REAL NOT NULL DEFAULT 0.5, confidence REAL NOT NULL DEFAULT 0.5, created_at INTEGER NOT NULL,
      PRIMARY KEY(source_id, target_id, view, relation));
    INSERT INTO memory_items(id, role, kind, content, created_at) VALUES ('a', 'user', 'fact', 'first', 1), ('b', 'user', 'fact', 'second', 2);
    INSERT INTO memory_edges VALUES ('a', 'b', 'semantic', 'related', 0.7, 0.7, 1), ('a', 'b', 'temporal', 'before', 0.5, 0.5, 1);
  `);
  legacy.close();
  const store = new MemoryStore(file);
  try {
    assert.deepEqual(store.neighboursOf("a").map(({ edge }) => `${edge.view}:${edge.relation}:${edge.origin}:${edge.weight}`), ["semantic:related:jev:0.7", "temporal:before:sequence:0.5"]);
    store.addEdge({ sourceId: "a", targetId: "b", view: "semantic", relation: "related", origin: "consolidation", weight: 0.9 }, { ifAbsent: true });
    store.addEdge({ sourceId: "a", targetId: "b", view: "semantic", relation: "related", origin: "consolidation", weight: 0.1 }, { ifAbsent: true });
    const related = store.neighboursOf("a").filter(({ edge }) => edge.relation === "related").map(({ edge }) => `${edge.origin}:${edge.weight}`);
    assert.deepEqual(related, ["jev:0.7", "consolidation:0.9"]);
    assert.equal(store.count().edges, 3);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
