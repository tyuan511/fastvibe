import { test } from "node:test";
import assert from "node:assert/strict";
import { assertForgottenReferences, reinforceSourceNotes, retainSourceNotes, type NoteRetentions } from "../src/main/bot/memory/retention.ts";
import { MEMORY_BASE_UNUSED_MS, MEMORY_MAX_SOURCES, memoryExpired, reinforceMemory } from "../src/main/engine/memory-retention.ts";
import type { ViviMemoryRead } from "../src/main/bot/memory/types.ts";

const START = Date.UTC(2026, 0, 1), DAY = 86_400_000;
const path = "rollout_summaries/example.md";
const note = `source_id: "input-42"\ncreated_at: ${START}\n\n## Raw memory\nweekly report structure\n`;
const read = (file: string, content = ""): ViviMemoryRead => ({ path: file, content, offset: 1, totalLines: 1, revision: "revision" });

test("legacy notes initialize from their own date, including explicit saves; missing dates initialize once", () => {
  const tree = new Map([[path, note], ["rollout_summaries/explicit-old.md", note], ["rollout_summaries/undated.md", "old note"]]);
  const records: NoteRetentions = {};
  const removed = retainSourceNotes(tree, records, START + MEMORY_BASE_UNUSED_MS + 1);
  assert.deepEqual(removed.sort(), [path, "rollout_summaries/explicit-old.md"].sort());
  const initialized = records["rollout_summaries/undated.md"].generatedAt;
  retainSourceNotes(tree, records, START + MEMORY_BASE_UNUSED_MS + DAY);
  assert.equal(records["rollout_summaries/undated.md"].generatedAt, initialized);
});

test("all notes share the capacity and strength ranking, independent of explicit filename", () => {
  const tree = new Map(Array.from({ length: MEMORY_MAX_SOURCES + 1 }, (_, i) => [`rollout_summaries/${i}.md`, `created_at: ${START + i}\n\n## Raw memory\n${"经验".repeat(500)}`]));
  tree.set("rollout_summaries/explicit-old.md", note);
  const removed = retainSourceNotes(tree, {}, START + DAY);
  assert.equal(removed.length, 2);
  assert.ok(removed.includes("rollout_summaries/explicit-old.md"));
  assert.equal([...tree.keys()].filter(key => key.startsWith("rollout_summaries/")).length, MEMORY_MAX_SOURCES);
  assert.ok(Buffer.byteLength(tree.get("raw_memories.md")!) <= 400_000);
  assert.ok(tree.get("raw_memories.md")!.includes("经验".repeat(500)), "a complete 1000-character CJK excerpt fits without a per-note byte cap");
});

test("only direct notes or exact path, basename, source_id in handbook excerpts reinforce", () => {
  for (const reference of [path, "example.md", "input-42"]) {
    const tree = new Map([[path, note]]), records: NoteRetentions = {};
    assert.equal(reinforceSourceNotes(tree, records, read("MEMORY.md", `Source: \`${reference}\`.`), START + DAY), true);
    assert.equal(records[path].reinforcementCount, 1);
    assert.equal(reinforceSourceNotes(tree, records, read(path), START + DAY), false);
    assert.equal(reinforceSourceNotes(tree, records, read(path), START + 2 * DAY), true);
    assert.equal(records[path].reinforcementCount, 2);
  }
  for (const file of ["memory_summary.md", "raw_memories.md", "unrelated.md"]) {
    const records: NoteRetentions = {};
    assert.equal(reinforceSourceNotes(new Map([[path, note]]), records, read(file, `${path} example.md input-42`), START + DAY), false);
    assert.deepEqual(records, {});
  }
  for (const content of ["not-example.md", "example.md.backup", "input-420", "prefix-input-42", "other/example.md"]) {
    const records: NoteRetentions = {};
    assert.equal(reinforceSourceNotes(new Map([[path, note]]), records, read("MEMORY.md", content), START + DAY), false);
    assert.deepEqual(records, {});
  }
});

test("expired note reads cannot revive it; old notes initialize even before first reinforcement", () => {
  const records: NoteRetentions = {};
  assert.equal(reinforceSourceNotes(new Map([[path, note]]), records, read(path), START + MEMORY_BASE_UNUSED_MS + 1), true);
  assert.deepEqual(records[path], { generatedAt: START });
  assert.equal(memoryExpired(records[path], START + MEMORY_BASE_UNUSED_MS + 1), true);
});

test("Vivi and ordinary helper reinforcement produce identical 30/60/120/240/360 day lifetimes", () => {
  let record = { generatedAt: START };
  const records: NoteRetentions = { [path]: record };
  const tree = new Map([[path, note]]);
  for (let count = 0; count < 8; count++) {
    const now = START + count * DAY;
    record = reinforceMemory(record, now);
    reinforceSourceNotes(tree, records, read(path), now);
    assert.deepEqual(records[path], record);
    const lifetime = Math.min(360, 30 * 2 ** count) * DAY;
    assert.equal(memoryExpired(record, now + lifetime), false);
    assert.equal(memoryExpired(record, now + lifetime + 1), true);
  }
});

test("dangling references reject publication; other surviving evidence may support the same knowledge", () => {
  for (const reference of [path, "example.md"]) {
    assert.throws(() => assertForgottenReferences(new Map([["MEMORY.md", reference]]), [path]), /reference/);
    assert.throws(() => assertForgottenReferences(new Map([["memory_summary.md", reference]]), [path]), /reference/);
  }
  assert.doesNotThrow(() => assertForgottenReferences(new Map([[path, note], ["MEMORY.md", path]]), [path]));
  assert.doesNotThrow(() => assertForgottenReferences(new Map([["rollout_summaries/other.md", `${note}\nHistorical source: ${path}`], ["MEMORY.md", "weekly report structure; source: other.md"]]), [path]));
});
