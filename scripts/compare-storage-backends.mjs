#!/usr/bin/env node
/**
 * 迁移前后的实测对比（`docs/sqlite-storage.md` §1 与 §8）。
 *
 * 设计文档自己写着「不是为了快」，所以「到底有没有收益」必须量，而不是叙述。这个脚本同时跑
 * **两份真代码**：
 *
 *   - 旧路径：`git show HEAD:` 取出的迁移前 store（不是复述），写在真实 userData 的副本上；
 *   - 新路径：现在的 store，写在同一个副本的 `fastvibe.db` 里。
 *
 * 每个 store 一个「一次用户动作」的场景（上一条回复的思考耗时、一次会话改名、一次引用计数+1、
 * 一次队列改动、一个节点写 output……），量中位耗时和真正落到磁盘上的字节。
 *
 * 新路径的落盘字节取 WAL 增量：每轮先 `wal_checkpoint(TRUNCATE)` 清零再跑一次动作，读 `-wal`
 * 大小。注意 SQLite 的粒度是页，改一行也要追加整页，所以「序列化量」和「落盘量」都列出来——
 * 两边都用同一个口径（这次动作让文件系统写了多少字节）。
 *
 *   node scripts/compare-storage-backends.mjs
 *   node scripts/compare-storage-backends.mjs --rounds=25 --keep
 *
 * 只在副本上跑，绝不碰正在运行的数据目录。
 */
import { execFileSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

const repo = join(new URL(".", import.meta.url).pathname, "..");
const argv = process.argv.slice(2);
const ROUNDS = Number(argv.find((a) => a.startsWith("--rounds="))?.slice(9) ?? 15);
const KEEP = argv.includes("--keep");
const SOURCE = argv.find((a) => a.startsWith("--from="))?.slice(7) || join(homedir(), "Library", "Application Support", "FastVibe");

const OLD_STORES = [
  "src/main/engine/reasoning-store.ts",
  "src/main/engine/conversation-catalog.ts",
  "src/main/engine/message-queue.ts",
  "src/main/engine/dag-store.ts",
  "src/main/engine/scheduled-tasks.ts",
  "src/main/engine/checkpoint.ts",
];

const engine = (name) => import(pathToFileURL(join(repo, "src/main/engine", `${name}.ts`)).href);

const work = mkdtempSync(join(tmpdir(), "fastvibe-backends-"));
const dir = join(work, basename(SOURCE));
const oldDir = join(work, "pristine");
mkdirSync(oldDir);
cpSync(SOURCE, dir, {
  recursive: true,
  filter: (item) =>
    !/\/(runtime\/engine\/(agent\/sessions|tool-images|memories|memories-baseline|scratch|office-preview|officecli-state|ssh-agent-runtimes|models|dag-runs)|logs|node_modules|Cache$|Code Cache|GPUCache|Partitions|Local Storage|Session Storage)(\/|$)/.test(item),
});

const NAMES = {
  catalog: "conversations.json",
  reasoning: "reasoning.json",
  memoryState: "memory-state.json",
  checkpoints: "checkpoints.json",
  queue: "message-queue.json",
  dag: "dag.json",
  schedules: "scheduled-tasks.json",
};
const where = {
  catalog: dirname(join(dir, NAMES.catalog)),
  reasoning: join(dir, "runtime", "engine"),
  memoryState: join(dir, "runtime", "engine"),
  checkpoints: join(dir, "runtime", "engine"),
  queue: join(dir, "runtime", "engine"),
  dag: dirname(join(dir, NAMES.dag)),
  schedules: join(dir, "runtime", "engine"),
};
/** 新 store 的导入会把副本里的旧文件改名，所以旧路径先用一份原样副本。 */
const OLD = {};
for (const [key, name] of Object.entries(NAMES)) {
  const live = join(where[key], name);
  if (existsSync(live)) cpSync(live, join(oldDir, name));
  OLD[key] = join(oldDir, name);
}
const scratch = join(dir, "runtime", "engine", "scratch");
mkdirSync(scratch, { recursive: true });

const rows = [];
const old = new Map();
const oldPaths = [];

function row(label, stats, note) {
  rows.push({ label, ...stats, note });
  const f = (n) => (n === null || n === undefined ? "—" : n.toFixed(n < 10 ? 2 : 1));
  console.log(
    `${label}\n  旧 ${f(stats.oldMs)}ms 落盘 ${kb(stats.oldBytes)}   |   新 ${f(stats.newMs)}ms 落盘 ${kb(stats.newBytes)}   |  ${ratio(stats)}`,
    stats.serialized ? `\n  序列化量 旧 ${kb(stats.oldSerialized)} → 新 ${kb(stats.newSerialized)}` : "",
  );
  if (note) console.log(`  note: ${note}`);
}

function ratio(stats) {
  const parts = [];
  if (stats.oldMs && stats.newMs) {
    const time = stats.oldMs / stats.newMs;
    parts.push(`耗时 ${time >= 1 ? `${time.toFixed(1)}× 快` : `${(1 / time).toFixed(1)}× 慢`}`);
  }
  if (stats.oldBytes && stats.newBytes) {
    const bytes = stats.oldBytes / stats.newBytes;
    parts.push(bytes >= 1.05 ? `落盘 ${bytes.toFixed(0)}× 少` : `落盘 ${(1 / bytes).toFixed(1)}× 多（页粒度 4 KB 的固定开销）`);
  }
  return parts.join("，") || "—";
}

function kb(value) {
  if (value === null || value === undefined) return "—";
  if (value < 1024) return `${Math.round(value)} B`;
  return value >= 1024 * 1024 ? `${(value / 1024 / 1024).toFixed(2)} MB` : `${(value / 1024).toFixed(1)} KB`;
}

async function timeOp(fn, rounds = ROUNDS) {
  const samples = [];
  for (let index = 0; index < rounds; index++) {
    const started = performance.now();
    await fn(index);
    samples.push(performance.now() - started);
  }
  samples.sort((a, b) => a - b);
  return samples[Math.floor(samples.length / 2)];
}

function walReset() {
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
}
function walBytes() {
  const file = `${dbFile}-wal`;
  return existsSync(file) ? statSync(file).size : 0;
}
/** 新路径一次动作真实追加了多少字节（WAL 帧 = 被改动的页）。 */
async function measureNew(fn) {
  walReset();
  const before = walBytes();
  await fn(0);
  return Math.max(walBytes() - before, 0);
}
/** 旧路径一次动作写入的字节 = 整份文件的长度（它就是整份重写）。 */
function measureOld(fn, file) {
  const size = existsSync(file) ? statSync(file).size : 0;
  return size;
}

const dbFile = join(dir, "fastvibe.db");
let db;

try {
  for (const file of OLD_STORES) {
    const source = execFileSync("git", ["show", `HEAD:${file}`], { cwd: repo, maxBuffer: 64 * 1024 * 1024 }).toString("utf8");
    const target = join(repo, "src", "main", "engine", `__old-${basename(file, ".ts")}.ts`);
    writeFileSync(target, source, "utf8");
    oldPaths.push(target);
    old.set(basename(file, ".ts"), await import(pathToFileURL(target).href));
  }

  const { openDatabase, openDatabaseConnection, closeDatabases } = await engine("db");
  const { ReasoningStore } = await engine("reasoning-store");
  const { ConversationCatalog } = await engine("conversation-catalog");
  const { MemoryStateStore } = await engine("memory-state");
  const { CheckpointStore } = await engine("checkpoint");
  const { MessageQueueStore } = await engine("message-queue");
  const { ScheduledTaskStore } = await engine("scheduled-tasks");
  const { DagStore } = await engine("dag-store");

  // ---------------------------------------------------------------- 启动时读全部状态
  const bytesOfAll = Object.values(OLD).reduce((total, file) => total + (existsSync(file) ? statSync(file).size : 0), 0);
  const oldOpenMs = await timeOp(() => {
    for (const file of Object.values(OLD)) {
      try {
        JSON.parse(readFileSync(file, "utf8"));
      } catch {
        /* 没有文件 = 首启 */
      }
    }
  }, 5);
  db = openDatabase(dbFile);
  let stores;
  const t0 = performance.now();
  stores = {
    reasoning: new ReasoningStore(db, { legacyFile: P("reasoning") }),
    memory: new MemoryStateStore(db, { legacyFile: P("memoryState") }),
    checkpoints: new CheckpointStore(db, { legacyFile: P("checkpoints") }),
    catalog: new ConversationCatalog(db, { scratchRoot: scratch, legacyFile: P("catalog") }),
    queue: new MessageQueueStore(db, { legacyFile: P("queue") }),
    schedules: new ScheduledTaskStore(db, { legacyFile: P("schedules") }),
    dag: new DagStore(db, { resultsDir: join(dir, "dag.json.results"), legacyFile: P("dag") }),
  };
  const newOpenMs = performance.now() - t0;
  const importedTotal = db.all("SELECT rows FROM legacy_imports").reduce((total, r) => total + Number(r.rows), 0);
  row("启动 ①：第一次打开（旧=解析 7 个文件；新=建库 + 导入 + 开 7 个 store）", { oldMs: oldOpenMs, newMs: newOpenMs, oldBytes: bytesOfAll, newBytes: statSync(dbFile).size + walBytes() }, `一次性代价：导入 ${importedTotal} 行，此后不再有`);

  // 稳态启动：旧路径每次都要读+解析全部文件，新路径只读表（旧文件已被改名，导入跳过）。
  const openOldStores = () => {
    new (old.get("reasoning-store").ReasoningStore)(OLD.reasoning);
    new (old.get("conversation-catalog").ConversationCatalog)(OLD.catalog, scratch);
    new (old.get("message-queue").MessageQueueStore)(OLD.queue);
    new (old.get("dag-store").DagStore)(OLD.dag);
    new (old.get("scheduled-tasks").ScheduledTaskStore)(OLD.schedules);
    JSON.parse(readFileSync(OLD.memoryState, "utf8"));
    JSON.parse(readFileSync(OLD.checkpoints, "utf8"));
  };
  const openNewStores = (target) => {
    new ReasoningStore(target);
    new ConversationCatalog(target, { scratchRoot: scratch });
    new MessageQueueStore(target);
    new DagStore(target, { resultsDir: join(dir, "dag.json.results") });
    new ScheduledTaskStore(target);
    new MemoryStateStore(target);
    new CheckpointStore(target);
  };
  const steadyOld = await timeOp(openOldStores, 5);
  const steadyNew = await timeOp(() => openNewStores(openDatabaseConnection(dbFile)), 5);
  row("启动 ②：稳态（第二次及以后打开这些数据）", { oldMs: steadyOld, newMs: steadyNew }, "旧=读并解析全部 JSON，新=从表里读同样的对象；两边都拿到同一份内存模型，所以这一行只比时间");
  function P(key) {
    return join(where[key], NAMES[key]);
  }

  // ---------------------------------------------------------------- 思考耗时
  {
    const oldStore = new (old.get("reasoning-store").ReasoningStore)(OLD.reasoning);
    let n = 0;
    const oldFn = () => {
      oldStore.set(`bench-${n++}`, [{ startedAt: 1, endedAt: 2000 }]);
      oldStore.flush();
    };
    let m = 0;
    const newFn = () => {
      stores.reasoning.set(`bench-${m++}`, [{ startedAt: 1, endedAt: 2000 }]);
      stores.reasoning.flush();
    };
    const oldMs = await timeOp(oldFn);
    const newMs = await timeOp(newFn);
    const entries = Object.keys(JSON.parse(readFileSync(OLD.reasoning, "utf8")).blocks ?? {}).length;
    row(`思考耗时：写一条新记录（表里 ${entries} 条）`, {
      oldMs,
      newMs,
      oldBytes: measureOld(oldFn, OLD.reasoning),
      newBytes: await measureNew(newFn),
      oldSerialized: statSync(OLD.reasoning).size,
      newSerialized: JSON.stringify([[1, 2000]]).length + 120,
      serialized: true,
    });
  }

  // ---------------------------------------------------------------- 记忆账本
  {
    // 旧路径 = HEAD `src/main/engine/memory.ts:272` + `:43-47`，逐字照抄：整份序列化 →
    // temp(mode 0600) → rename。旧代码把这个写包在一个会起定时器的 manager 里，实例化一次
    // 就会混进别的开销，所以这里只取那两行。
    // HEAD 的同步版另有 mkdirSync(dirname(file))，这里目录已存在。
    const atomic = (file, content) => {
      const temp = `${file}.${process.pid}.tmp`;
      writeFileSync(temp, content, { mode: 0o600 });
      chmodSync(temp, 0o600);
      renameSync(temp, file);
    };
    const legacy = JSON.parse(readFileSync(OLD.memoryState, "utf8"));
    const ids = Object.keys(legacy.outputs ?? {});
    let n = 0;
    const oldFn = () => {
      legacy.outputs[ids[n % ids.length]].usageCount += 1;
      n += 1;
      atomic(OLD.memoryState, `${JSON.stringify(legacy)}\n`);
    };
    const state = stores.memory.load();
    let m = 0;
    const newFn = () => {
      state.outputs[ids[m % ids.length]].usageCount += 1;
      m += 1;
      stores.memory.save(state);
    };
    const oldMs = await timeOp(oldFn);
    const newMs = await timeOp(newFn);
    row(`记忆账本：一次引用让 usageCount+1（${ids.length} 条 output）`, {
      oldMs,
      newMs,
      oldBytes: statSync(OLD.memoryState).size,
      newBytes: await measureNew(newFn),
      oldSerialized: JSON.stringify(legacy).length,
      newSerialized: JSON.stringify(state.outputs[ids[0]]).length,
      serialized: true,
    });
  }

  // ---------------------------------------------------------------- 会话目录
  {
    const oldCatalog = new (old.get("conversation-catalog").ConversationCatalog)(OLD.catalog, scratch);
    const oldId = oldCatalog.list()[0].id;
    let n = 0;
    const oldFn = () => {
      oldCatalog.update(oldId, { title: `renamed ${n++}` });
      oldCatalog.flush();
    };
    const catalog = stores.catalog;
    const id = catalog.list()[0].id;
    let m = 0;
    const newFn = () => {
      catalog.update(id, { title: `renamed ${m++}` });
      catalog.flush();
    };
    const oldMs = await timeOp(oldFn);
    const newMs = await timeOp(newFn);
    row(`会话目录：改一个会话的标题（${catalog.list().length} 个会话）`, {
      oldMs,
      newMs,
      oldBytes: statSync(OLD.catalog).size,
      newBytes: await measureNew(newFn),
      oldSerialized: JSON.stringify({ version: 2, activeId: undefined, projects: [], conversations: oldCatalog.listAll() }, null, 2).length,
      newSerialized: JSON.stringify(catalog.get(id)).length,
      serialized: true,
    });
  }

  // ---------------------------------------------------------------- 排队消息
  {
    const oldQueue = new (old.get("message-queue").MessageQueueStore)(OLD.queue);
    const oldId = oldQueue.add({ conversationId: "bench", text: "one", behavior: "followUp" }).id;
    let n = 0;
    const oldFn = () => oldQueue.update(oldId, { text: `tick ${n++}` });
    const queue = stores.queue;
    const id = queue.add({ conversationId: "bench", text: "one", behavior: "followUp" }).id;
    let m = 0;
    const newFn = () => queue.update(id, { text: `tick ${m++}` });
    const oldMs = await timeOp(oldFn);
    const newMs = await timeOp(newFn);
    row("排队消息：一次改动（两边都是每次改动立即落盘）", {
      oldMs,
      newMs,
      oldBytes: statSync(OLD.queue).size,
      newBytes: await measureNew(newFn),
    });
  }

  // ---------------------------------------------------------------- 定时任务
  {
    const inSix = new Date(Date.now() + 6e5).toISOString();
    const oldSchedules = new (old.get("scheduled-tasks").ScheduledTaskStore)(OLD.schedules);
    const oldTask = oldSchedules.create({ name: "bench", prompt: "work", schedule: { kind: "once", at: inSix } });
    let n = 0;
    const oldFn = () => oldSchedules.update(oldTask.id, { name: `renamed ${n++}` });
    const task = stores.schedules.create({ name: "bench", prompt: "work", schedule: { kind: "once", at: inSix } });
    let m = 0;
    const newFn = () => stores.schedules.update(task.id, { name: `renamed ${m++}` });
    const oldMs = await timeOp(oldFn);
    const newMs = await timeOp(newFn);
    row("定时任务：一次改动（本机数据是空的，绝对差值无意义）", {
      oldMs,
      newMs,
      oldBytes: statSync(OLD.schedules).size,
      newBytes: await measureNew(newFn),
    });
  }

  // ---------------------------------------------------------------- DAG
  {
    const seed = (target) =>
      target.append("bench-chat", (allocate) =>
        Array.from({ length: 100 }, () => ({
          id: allocate(),
          title: "task",
          instruction: "do the thing with a reasonably long instruction body",
          profile: { name: "worker", instructions: "work" },
          dependsOn: [],
          status: "pending",
        })),
      );
    const oldDagFile = join(oldDir, "dag-bench.json");
    writeFileSync(oldDagFile, JSON.stringify({ version: 1, seq: 1, graphs: [] }), "utf8");
    const oldDag = new (old.get("dag-store").DagStore)(oldDagFile);
    const oldNodes = seed(oldDag);
    oldDag.flush();
    const newDag = new DagStore(db, { resultsDir: join(dir, "dag-bench.results") });
    const newNodes = seed(newDag);
    newDag.flush();
    const oldTarget = oldNodes[41].id;
    const newTarget = newNodes[41].id;
    let n = 0;
    const oldFn = () => {
      oldDag.patch("bench-chat", oldTarget, { output: `result ${n++} ${"x".repeat(2000)}` });
      oldDag.flush();
    };
    let m = 0;
    const newFn = () => {
      newDag.patch("bench-chat", newTarget, { output: `result ${m++} ${"x".repeat(2000)}` });
      newDag.flush();
    };
    const oldMs = await timeOp(oldFn);
    const newMs = await timeOp(newFn);
    row("DAG：100 节点（合成，真实数据为空）里改一个节点的 output", {
      oldMs,
      newMs,
      oldBytes: statSync(oldDagFile).size,
      newBytes: await measureNew(newFn),
    });
  }

  // ---------------------------------------------------------------- 检查点
  {
    const checkpoints = JSON.parse(readFileSync(OLD.checkpoints, "utf8"));
    const fileBytes = (list) => list.reduce((total, item) => total + (item.files ?? []).reduce((n, f) => n + (f.content?.length ?? f.binary?.length ?? 0), 0), 0);
    const oldCk = old.get("checkpoint");
    // 旧 store 是模块级 Map + 两个整份读写的函数：先把真实数据装进去，再量退出时那一次写入。
    await oldCk.loadCheckpoints(OLD.checkpoints);
    const oldMs = await timeOp(async () => await oldCk.saveCheckpoints(OLD.checkpoints), 5);
    const oldBytesWritten = statSync(OLD.checkpoints).size;

    // 新路径写一个会话（与 `CheckpointStore#writeRows` 同一组语句）。`capture()` 另有每文件
    // 一次 `git rev-parse --show-toplevel`，两边都有，不是这次迁移的账。
    const writeOne = (checkpoint) => {
      db.transaction(() => {
        db.run("DELETE FROM checkpoints WHERE conversation_id = ?", checkpoint.conversationId);
        db.run(
          "INSERT INTO checkpoints (conversation_id, cwd, created_at, head, repos) VALUES (?, ?, ?, ?, ?)",
          checkpoint.conversationId,
          checkpoint.cwd,
          checkpoint.createdAt,
          checkpoint.head,
          checkpoint.repos ? JSON.stringify(checkpoint.repos) : undefined,
        );
        for (const [index, file] of checkpoint.files.entries()) {
          db.run("INSERT INTO checkpoint_files (conversation_id, seq, path, data) VALUES (?, ?, ?, ?)", checkpoint.conversationId, index, file.path, JSON.stringify(file));
        }
      });
    };
    const biggest = checkpoints.reduce((big, item) => ((item.files?.length ?? 0) > (big.files?.length ?? 0) ? item : big), checkpoints[0]);
    const medianMs = await timeOp(() => writeOne(checkpoints[Math.floor(Math.random() * checkpoints.length)]), 15);
    walReset();
    const bigMs = await timeOp(() => writeOne(biggest), 3);
    // 单独量一次的落盘：上面 3 轮的 WAL 是累计的，这里清零后只写一次。
    walReset();
    writeOne(biggest);
    const bigBytes = walBytes();
    row(
      `检查点：旧=捕获时什么都不写、退出时整份写 ${kb(oldBytesWritten)}；新=捕获时写一个会话`,
      { oldMs, newMs: medianMs, oldBytes: oldBytesWritten, newBytes: bigBytes },
      `真实数据 ${checkpoints.length} 个会话 / ${checkpoints.reduce((n, c) => n + (c.files?.length ?? 0), 0)} 个文件 / ${kb(fileBytes(checkpoints))} 内容。最大一个会话的检查点（${biggest.files.length} 文件 ${kb(fileBytes([biggest]))}）新路径耗时 ${bigMs.toFixed(1)}ms。崩溃收益不在数字里：旧版丢掉全部 ${checkpoints.length} 个检查点。`,
    );
  }

  // ---------------------------------------------------------------- 磁盘与收缩
  const jsonTotal = Object.values(OLD).reduce((total, file) => total + (existsSync(file) ? statSync(file).size : 0), 0);
  closeDatabases();
  const dbTotal = statSync(dbFile).size;
  const fresh = openDatabase(dbFile);
  fresh.run("DELETE FROM checkpoints");
  fresh.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  const beforeVacuum = statSync(dbFile).size;
  fresh.exec("PRAGMA incremental_vacuum");
  fresh.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  const afterVacuum = statSync(dbFile).size;
  fresh.close();
  closeDatabases();
  row(`磁盘占用（7 份 JSON → 一个库）`, { oldMs: null, newMs: null, oldBytes: jsonTotal, newBytes: dbTotal }, `删掉检查点后 ${kb(beforeVacuum)} → ${kb(afterVacuum)}（auto_vacuum=INCREMENTAL）`);

  // ---------------------------------------------------------------- 外推
  const reasoningSize = statSync(OLD.reasoning).size;
  const pageSize = 4096;
  console.log("\n按真实尺寸外推一段长时间运行的累计写入");
  console.log(`  思考耗时 100 次落盘：旧 ${kb(reasoningSize * 100)}（整份 ${kb(reasoningSize)} 重写）vs 新 ≈ ${kb(pageSize * 100)}（每轮追加被改动的页）`);
  console.log(`  会话目录 100 次 flush：旧 ${kb(statSync(OLD.catalog).size * 100)} vs 新 ≈ ${kb(pageSize * 100)}`);
  console.log(`  退出时检查点：旧 ${kb(statSync(OLD.checkpoints).size)}（捕获时 0 字节，崩溃全丢）`);
} finally {
  for (const path of oldPaths) rmSync(path, { force: true });
  const leftovers = readdirSync(join(repo, "src", "main", "engine")).filter((name) => name.startsWith("__old-"));
  if (leftovers.length) console.error(`⚠ 旧代码临时文件没删干净：${leftovers.join(", ")}`);
  const dirty = execFileSync("git", ["status", "--porcelain", "src/main/engine"], { cwd: repo }).toString().trim();
  if (dirty.split("\n").length > 12) console.error("⚠ src/main/engine 下有预期外改动");
  console.log(`\n副本：${KEEP ? dir : "（已删除）"}`);
  if (!KEEP) rmSync(work, { recursive: true, force: true });
}
