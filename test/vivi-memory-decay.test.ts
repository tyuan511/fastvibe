import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ViviMemoryService } from "../src/main/bot/memory/service.ts";
import { initialTree } from "../src/main/bot/memory/files.ts";
import { MEMORY_BASE_UNUSED_MS } from "../src/main/engine/memory-retention.ts";

const DAY = 86_400_000;
const START = Date.UTC(2026, 0, 1);
const expired = "rollout_summaries/old.md";
const explicit = "rollout_summaries/explicit-old.md";
const retained = "rollout_summaries/useful.md";
const note = (at: number, text = "checked workflow") => `created_at: ${at}\n\n${text}\n\n## Raw memory\n${text}\n`;

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "vivi-decay-"));
  let clock = START;
  let extractions = 0;
  let consolidations = 0;
  const options = {
    root: join(dir, "memories"), now: () => clock, sources: () => [], debounceMs: 100_000,
    complete: async () => { extractions++; throw new Error("Maintenance must not re-extract old sources"); },
    consolidate: async ({ cwd }: { cwd: string }) => {
      consolidations++;
      writeFileSync(join(cwd, "MEMORY.md"), `# Retained knowledge\n\n${retained}\n`);
      writeFileSync(join(cwd, "memory_summary.md"), "v1\n\n## Index\nRetained knowledge: MEMORY.md\n");
    },
  };
  const service = new ViviMemoryService(options);
  return {
    service, options, dir, setClock: (now: number) => { clock = now; },
    counts: () => ({ extractions, consolidations }),
    seed: async () => {
      await service.run();
      await service.files.locked(() => {
        const tree = initialTree();
        tree.set(expired, note(START));
        tree.set(explicit, note(START, "Explicitly remembered instruction"));
        tree.set(retained, note(START));
        tree.set("MEMORY.md", `# Knowledge\n${expired}\n${explicit}\n${retained}\n`);
        tree.set("memory_summary.md", "v1\n\n## Index\nKnowledge: MEMORY.md\n");
        const state = service.files.state();
        state.retention = {
          [expired]: { generatedAt: START },
          [explicit]: { generatedAt: START },
          [retained]: { generatedAt: START, lastUsage: START + DAY, lastReinforcedAt: START + DAY, reinforcementCount: 1 },
        };
        service.files.publish(tree, state);
      });
    },
    close: async () => { await service.stop(); rmSync(dir, { recursive: true, force: true }); },
  };
}

test("Vivi expires automatic and explicitly saved notes without new input, consolidates once and keeps reinforced knowledge", async () => {
  const f = fixture();
  try {
    await f.seed();
    f.setClock(START + MEMORY_BASE_UNUSED_MS + 1);
    await f.service.run();
    assert.deepEqual(f.counts(), { extractions: 0, consolidations: 1 });
    const snapshot = await f.service.files.locked(() => f.service.files.snapshot());
    assert.equal(snapshot.tree.has(expired), false);
    assert.equal(snapshot.tree.has(explicit), false);
    assert.equal(snapshot.tree.has(retained), true);
    assert.deepEqual(Object.keys(snapshot.state.retention!), [retained]);
    assert.doesNotMatch(snapshot.tree.get("raw_memories.md")!, /old\.md/);
    assert.equal(readFileSync(join(f.dir, "memories-baseline", "MEMORY.md"), "utf8"), snapshot.tree.get("MEMORY.md"));
    await f.service.run();
    assert.equal(f.counts().consolidations, 1, "an unchanged retained collection does not call the model again");
  } finally { await f.close(); }
});

test("expiring the last sources clears raw notes, handbook links and index without replaying history", async () => {
  const f = fixture();
  try {
    await f.seed();
    f.setClock(START + 100 * DAY);
    f.options.consolidate = async ({ cwd }) => {
      writeFileSync(join(cwd, "MEMORY.md"), "# Vivi memory\n");
      writeFileSync(join(cwd, "memory_summary.md"), "v1\n\n## Memory index\n");
      // A model may copy an old source back from its context; sources are host-owned.
      mkdirSync(join(cwd, "rollout_summaries"), { recursive: true });
      writeFileSync(join(cwd, expired), note(START));
    };
    await f.service.run();
    const snapshot = await f.service.files.locked(() => f.service.files.snapshot());
    assert.equal([...snapshot.tree.keys()].some(path => path.startsWith("rollout_summaries/")), false);
    assert.deepEqual(snapshot.state.retention, {});
    assert.doesNotMatch(snapshot.tree.get("raw_memories.md")!, /old\.md|useful\.md/);
    assert.equal(snapshot.tree.get("MEMORY.md"), "# Vivi memory\n");
    assert.equal(f.counts().extractions, 0);
  } finally { await f.close(); }
});

test("failed expiration cleanup keeps the last complete publication and bounds maintenance retries", async () => {
  const f = fixture();
  try {
    await f.seed();
    f.setClock(START + MEMORY_BASE_UNUSED_MS + 1);
    const before = await f.service.context();
    let attempts = 0;
    f.options.consolidate = async () => { attempts++; };
    for (let i = 0; i < 3; i++) {
      f.setClock(START + MEMORY_BASE_UNUSED_MS + 1 + i * DAY);
      await assert.rejects(f.service.run(), /reference/i);
      assert.equal((await f.service.context()).revision, before.revision);
    }
    f.setClock(START + MEMORY_BASE_UNUSED_MS + 5 * DAY);
    await f.service.run();
    assert.equal(attempts, 3);
    assert.equal((await f.service.files.locked(() => f.service.files.snapshot())).tree.has(expired), true);
  } finally { await f.close(); }
});

test("summary injection and search do not reinforce; bounded reads and referenced excerpts reinforce once per day", async () => {
  const f = fixture();
  try {
    await f.seed();
    f.setClock(START + 3 * DAY);
    const before = await f.service.files.locked(() => f.service.files.state());
    await f.service.context();
    await f.service.search("workflow");
    await f.service.read("memory_summary.md");
    const untouched = await f.service.files.locked(() => f.service.files.state());
    assert.deepEqual(untouched.retention, before.retention);
    await f.service.read(retained, 1, 2);
    const used = await f.service.files.locked(() => f.service.files.state());
    assert.equal(used.retention![retained].reinforcementCount, 2);
    await f.service.read(retained);
    await f.service.context([{ path: retained }]);
    assert.deepEqual((await f.service.files.locked(() => f.service.files.state())).retention, used.retention);
    assert.equal(used.retention![expired].reinforcementCount, undefined);
    const reopened = new ViviMemoryService(f.options);
    await reopened.read(retained);
    assert.equal((await reopened.files.locked(() => reopened.files.state())).retention![retained].reinforcementCount, 2);
    await reopened.stop();
  } finally { await f.close(); }
});

test("a read that reinforces memory invalidates an older expiration publication", async () => {
  const f = fixture();
  let entered!: () => void;
  let release!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  try {
    await f.seed();
    f.setClock(START + MEMORY_BASE_UNUSED_MS + 1);
    const consolidate = f.options.consolidate;
    f.options.consolidate = async request => { entered(); await held; await consolidate(request); };
    const run = f.service.run();
    const rejected = assert.rejects(run, /changed during consolidation/);
    await ready;
    await f.service.read(retained);
    release();
    await rejected;
    const snapshot = await f.service.files.locked(() => f.service.files.snapshot());
    assert.equal(snapshot.tree.has(expired), true, "an aborted transaction must not partially delete notes");
    assert.equal(snapshot.state.retention![retained].reinforcementCount, 2);
    await f.service.run();
    assert.equal((await f.service.files.locked(() => f.service.files.snapshot())).tree.has(expired), false);
  } finally { release?.(); await f.close(); }
});
