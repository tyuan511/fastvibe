import { test } from "node:test";
import assert from "node:assert/strict";
import { selectForConsolidation, staleOutputIds, type Stage1Output } from "../src/main/engine/memory-plan.ts";
import { retainSourceNotes } from "../src/main/bot/memory/retention.ts";
import { initialTree } from "../src/main/bot/memory/files.ts";
import { MEMORY_BASE_UNUSED_MS, MEMORY_MAX_SOURCES, type MemoryRetention } from "../src/main/engine/memory-retention.ts";

const DAY = 86_400_000;
const START = Date.UTC(2026, 0, 1);
const notePath = (id: string) => `rollout_summaries/${id}.md`;
const output = (id: string, retention: MemoryRetention): Stage1Output => ({
  conversationId: id, cwd: "/project", rolloutPath: `/sessions/${id}.jsonl`, createdAt: START,
  sourceUpdatedAt: retention.generatedAt, rawMemory: id, rolloutSummary: id, slug: id,
  usageCount: 0, ...retention,
});

test("ordinary and Vivi memory select the same sources using shared decay, strengthening, expiration and capacity", () => {
  const now = START + 50 * DAY;
  const outputs = Array.from({ length: MEMORY_MAX_SOURCES + 50 }, (_, i) => output(`source-${i.toString().padStart(4, "0")}`, {
    generatedAt: now - i * DAY / 4,
    reinforcementCount: i % 5,
    ...(i % 3 === 0 ? { lastUsage: now - i * DAY / 8 } : {}),
  }));
  // A high old lifetime count must not pin the source in either implementation.
  outputs.push({ ...output("stale-frequent", { generatedAt: START }), usageCount: 10_000 });
  const tree = initialTree();
  const retention: Record<string, MemoryRetention> = {};
  for (const source of outputs) {
    const path = notePath(source.conversationId);
    tree.set(path, `created_at: ${source.generatedAt}\n\n## Raw memory\n${source.rawMemory}\n`);
    retention[path] = { generatedAt: source.generatedAt, lastUsage: source.lastUsage, reinforcementCount: source.reinforcementCount };
  }
  retainSourceNotes(tree, retention, now);
  const expected = selectForConsolidation(outputs, now).map(source => notePath(source.conversationId)).sort();
  assert.deepEqual([...tree.keys()].filter(path => path.startsWith("rollout_summaries/")).sort(), expected);
  assert.equal(expected.length, MEMORY_MAX_SOURCES);
});

test("both systems use the exact 30 day boundary for unreinforced and explicitly saved notes", () => {
  for (const id of ["automatic", "explicit-saved"]) {
    for (const delta of [-1, 0, 1]) {
      const now = START + MEMORY_BASE_UNUSED_MS + delta;
      const source = output(id, { generatedAt: START });
      const tree = initialTree();
      tree.set(notePath(id), `created_at: ${START}\n\n## Raw memory\nremembered\n`);
      retainSourceNotes(tree, {}, now);
      assert.equal(tree.has(notePath(id)), !staleOutputIds([source], now).includes(id));
      assert.equal(tree.has(notePath(id)), delta <= 0);
    }
  }
});
