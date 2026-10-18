#!/usr/bin/env node
/**
 * Performance baseline for the SQLite storage (`docs/sqlite-storage.md` §8).
 *
 * This is not a gate. It exists so a regression has something to be compared against — the
 * migration's own promise is not speed, so a number that gets worse is a question to answer,
 * not a build failure. It measures the three costs the design called out:
 *
 *   - the checkpoint written at capture time, synchronously, on Main's thread, up to 32 MB;
 *   - a conversation-catalog flush (a row-level diff, and what it costs to say so);
 *   - the cost of opening the database and every store on it at startup.
 *
 *   node scripts/bench-sqlite.mjs
 *
 * The checkpoint numbers are the *storage* cost alone: `captureCheckpoint` also runs one
 * `git rev-parse --show-toplevel` per file, which is minutes for a 200-file turn and was the
 * price before this migration too. That is why this calls the row write, not `capture()`.
 */
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const here = new URL(".", import.meta.url).pathname;
const { openDatabase, closeDatabases } = await import(pathToFileURL(join(here, "../src/main/engine/db.ts")).href);
const { CheckpointStore } = await import(pathToFileURL(join(here, "../src/main/engine/checkpoint.ts")).href);
const { ConversationCatalog } = await import(pathToFileURL(join(here, "../src/main/engine/conversation-catalog.ts")).href);
const { ReasoningStore } = await import(pathToFileURL(join(here, "../src/main/engine/reasoning-store.ts")).href);
const { MessageQueueStore } = await import(pathToFileURL(join(here, "../src/main/engine/message-queue.ts")).href);
const { ScheduledTaskStore } = await import(pathToFileURL(join(here, "../src/main/engine/scheduled-tasks.ts")).href);
const { MemoryStateStore } = await import(pathToFileURL(join(here, "../src/main/engine/memory-state.ts")).href);
const { DagStore } = await import(pathToFileURL(join(here, "../src/main/engine/dag-store.ts")).href);

const dir = mkdtempSync(join(tmpdir(), "fastvibe-sqlite-bench-"));
const db = openDatabase(join(dir, "fastvibe.db"));
const MB = 1024 * 1024;

function time(label, runs, body) {
  const samples = [];
  for (let index = 0; index < runs; index++) {
    const started = performance.now();
    body(index);
    samples.push(performance.now() - started);
  }
  samples.sort((a, b) => a - b);
  const mid = samples[Math.floor(samples.length / 2)];
  console.log(`${label.padEnd(46)} 中位 ${mid.toFixed(2)}ms  最慢 ${samples[samples.length - 1].toFixed(2)}ms`);
  return mid;
}

// ---- checkpoint: the store's own write, at the sizes the bounds allow ------------------
const files = (count, kb) =>
  Array.from({ length: count }, (_, index) => ({
    path: `/work/app/src/module-${index}.ts`,
    content: "x".repeat(kb * 1024),
    bytes: kb * 1024,
  }));

const store = new CheckpointStore(db);
/**
 * The row writes, spelled out here rather than called on the store: `capture()` also asks
 * git for a baseline per file, and that (pre-existing, ~5 ms a spawn) would hide the number
 * this is meant to watch. Same statements as `CheckpointStore#writeRows`.
 */
const captureCost = (list) => {
  db.transaction(() => {
    db.run("DELETE FROM checkpoints WHERE conversation_id = ?", "bench");
    db.run("INSERT INTO checkpoints (conversation_id, cwd, created_at, head, repos) VALUES (?, ?, ?, ?, ?)", "bench", "/work/app", Date.now(), "abc", null);
    for (const [index, file] of list.entries()) {
      db.run("INSERT INTO checkpoint_files (conversation_id, seq, path, data) VALUES (?, ?, ?, ?)", "bench", index, file.path, JSON.stringify(file));
    }
  });
};
console.log("检查点写入（只算存储，不含 capture 里的 git rev-parse）");
time("1 文件 × 2 MB（单文件上限）", 3, () => captureCost(files(1, 2048)));
time("35 文件 × 8 KB（作者机器上的形状）", 5, () => captureCost(files(35, 8)));
time("16 文件 × 2 MB（32 MB 整份上限）", 3, () => captureCost(files(16, 2048)));
time("200 文件 × 100 KB（份数上限）", 3, () => captureCost(files(200, 100)));
time("清空一个 32 MB 检查点", 3, () => store.clear("bench"));

// ---- catalog flush ---------------------------------------------------------------------
console.log("\n会话目录");
const catalog = new ConversationCatalog(db, { scratchRoot: join(dir, "scratch") });
for (let index = 0; index < 50; index++) catalog.create(index % 5 === 0 ? undefined : `/work/project-${index % 5}`);
catalog.flush();
time("flush，什么都没改（50 个会话 / 5 个项目）", 20, () => catalog.flush());
time("flush，改一个会话的标题", 20, () => {
  catalog.update(catalog.list()[0].id, { title: `t-${Date.now()}` });
  catalog.flush();
});
time("新建一个 store 并读完整份目录", 10, () => new ConversationCatalog(db, { scratchRoot: join(dir, "scratch") }));

// ---- opening every store on a fresh database ------------------------------------------
console.log("\n启动时打开所有 store");
const size = statSync(join(dir, "fastvibe.db")).size;
console.log(`\n上面这些写入之后的库文件：${(size / MB).toFixed(2)} MB`);
closeDatabases();
const cold = mkdtempSync(join(tmpdir(), "fastvibe-sqlite-bench2-"));
time("建库 + 跑完 schema 迁移 + 打开 6 个 store", 5, () => {
  const fresh = openDatabase(join(cold, "fastvibe.db"));

  new CheckpointStore(fresh);
  new ConversationCatalog(fresh, { scratchRoot: join(cold, "scratch") });
  new ReasoningStore(fresh);
  new MessageQueueStore(fresh);
  new ScheduledTaskStore(fresh);
  new MemoryStateStore(fresh);
  new DagStore(fresh, { resultsDir: join(cold, "dag.json.results") });
  fresh.close();
  rmSync(join(cold, "fastvibe.db"), { force: true });
  rmSync(`${join(cold, "fastvibe.db")}-wal`, { force: true });
  rmSync(`${join(cold, "fastvibe.db")}-shm`, { force: true });
});
closeDatabases();
rmSync(dir, { recursive: true, force: true });
rmSync(cold, { recursive: true, force: true });
