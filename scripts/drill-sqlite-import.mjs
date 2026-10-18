#!/usr/bin/env node
/**
 * Import drill against a copy of real user data (`docs/sqlite-storage.md` §8).
 *
 * It copies `<userData>` into a temp directory, opens every migrated store over a fresh
 * database with the copies as its legacy files, and compares what came out with what went
 * in — row counts and the round-tripped objects. Nothing here touches a running data
 * directory: the copy is the point, because a drill that could damage the real catalog is
 * not a drill.
 *
 *   node scripts/drill-sqlite-import.mjs                       # this machine's FastVibe
 *   node scripts/drill-sqlite-import.mjs --from=/path/to/userData
 *   node scripts/drill-sqlite-import.mjs --keep                # leave the copy behind
 *
 * Exit code is non-zero when anything failed to match, so it can be run before a release.
 */
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";

const here = new URL(".", import.meta.url).pathname;
const repo = join(here, "..");
const argv = process.argv.slice(2);
const source =
  argv.find((item) => item.startsWith("--from="))?.slice("--from=".length) ||
  join(homedir(), "Library", "Application Support", "FastVibe");

const { openDatabase, closeDatabases } = await import(pathToFileURL(join(repo, "src/main/engine/db.ts")).href);
const { ConversationCatalog } = await import(pathToFileURL(join(repo, "src/main/engine/conversation-catalog.ts")).href);
const { ReasoningStore } = await import(pathToFileURL(join(repo, "src/main/engine/reasoning-store.ts")).href);
const { MemoryStateStore } = await import(pathToFileURL(join(repo, "src/main/engine/memory-state.ts")).href);
const { CheckpointStore, checkpointFile } = await import(pathToFileURL(join(repo, "src/main/engine/checkpoint.ts")).href);
const { MessageQueueStore } = await import(pathToFileURL(join(repo, "src/main/engine/message-queue.ts")).href);
const { ScheduledTaskStore } = await import(pathToFileURL(join(repo, "src/main/engine/scheduled-tasks.ts")).href);
const { DagStore } = await import(pathToFileURL(join(repo, "src/main/engine/dag-store.ts")).href);

const problems = [];
const notes = [];

function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) problems.push(`${label}: 实际 ${trunc(JSON.stringify(actual))} ≠ 期望 ${trunc(JSON.stringify(expected))}`);
  notes.push(`${ok ? "ok  " : "FAIL"} ${label}`);
}

function trunc(text) {
  return text && text.length > 300 ? `${text.slice(0, 300)}…` : text;
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
}

if (!existsSync(source)) {
  console.error(`找不到数据目录：${source}`);
  process.exit(1);
}

const work = mkdtempSync(join(tmpdir(), "fastvibe-import-drill-"));
const dir = join(work, basename(source));
cpSync(source, dir, {
  recursive: true,
  // Transcripts, tool images and the memories folder can be gigabytes; the drill reads only
  // the JSON files that are being imported, and copying them is what proves the copy is
  // beside the running data rather than the running data itself.
  filter: (item) => !/\/(runtime\/engine\/(agent\/sessions|tool-images|memories|memories-baseline|scratch|office-preview|dag-runs)|logs|node_modules)(\/|$)/.test(item),
});
const runtimeRoot = join(dir, "runtime", "engine");
const dbFile = join(dir, "fastvibe.db");
const db = openDatabase(dbFile);

console.log(`演练数据：${dir}（源：${source}）`);

// -- catalog ---------------------------------------------------------------------------
const catalogFile = join(dir, "conversations.json");
const catalogSource = readJson(catalogFile);
const catalog = new ConversationCatalog(db, { scratchRoot: join(dir, "runtime", "engine", "scratch"), legacyFile: catalogFile });
if (catalogSource) {
  const stored = db.all("SELECT id, data FROM conversations");
  check("catalog 会话行数", stored.length, (catalogSource.conversations ?? []).length);
  check("catalog 项目行数", db.countRows("projects"), (catalogSource.projects ?? []).length);
  const byId = new Map(stored.map((row) => [row.id, JSON.parse(row.data)]));
  const mismatched = (catalogSource.conversations ?? []).filter((item) => JSON.stringify(byId.get(item.id)) !== JSON.stringify(item));
  check("catalog 每个会话往返一致", mismatched.map((item) => item.id), []);
  check("catalog 打开的会话", catalog.activeId ?? null, catalogSource.activeId ?? catalog.list()[0]?.id ?? null);
  // The order the file kept is the order the store keeps: newest created first.
  check("catalog 列表顺序", catalog.list().map((item) => item.id), [...(catalogSource.conversations ?? [])].sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0) || a.id.localeCompare(b.id)).map((item) => item.id));
} else {
  notes.push("--   catalog 没有旧文件");
}

// -- reasoning ------------------------------------------------------------------------
const reasoningFile = join(runtimeRoot, "reasoning.json");
const reasoningSource = readJson(reasoningFile);
const reasoning = new ReasoningStore(db, { legacyFile: reasoningFile });
if (reasoningSource?.blocks) {
  const kept = Object.entries(reasoningSource.blocks).filter(([, blocks]) => Array.isArray(blocks) && blocks.length > 0);
  check("reasoning 行数", db.countRows("reasoning_blocks"), Math.min(kept.length, 5000));
  const lost = kept.filter(([id]) => reasoning.get(id) === undefined);
  check("reasoning 每条都读得回来", lost.map(([id]) => id), []);
} else {
  notes.push("--   reasoning 没有旧文件");
}

// -- memory state ---------------------------------------------------------------------
const memoryStateFile = join(runtimeRoot, "memory-state.json");
const memorySource = readJson(memoryStateFile);
const memory = new MemoryStateStore(db, { legacyFile: memoryStateFile });
if (memorySource) {
  const loaded = memory.load();
  check("memory outputs 行数", Object.keys(loaded.outputs ?? {}).length, Object.keys(memorySource.outputs ?? {}).length);
  check("memory empty 行数", Object.keys(loaded.empty ?? {}).length, Object.keys(memorySource.empty ?? {}).length);
  check("memory failures 行数", Object.keys(loaded.failures ?? {}).length, Object.keys(memorySource.failures ?? {}).length);
  check("memory 每条 output 往返一致", Object.keys(loaded.outputs ?? {}).filter((id) => JSON.stringify(loaded.outputs[id]) !== JSON.stringify(memorySource.outputs[id])), []);
  check("memory lastRunAt", loaded.lastRunAt ?? null, memorySource.lastRunAt ?? null);
} else {
  notes.push("--   memory-state 没有旧文件");
}

// -- checkpoints ----------------------------------------------------------------------
const checkpointsFile = checkpointFile(runtimeRoot);
const checkpointSource = readJson(checkpointsFile);
const checkpoints = new CheckpointStore(db, { legacyFile: checkpointsFile });
if (Array.isArray(checkpointSource)) {
  check("checkpoints 行数", db.countRows("checkpoints"), checkpointSource.length);
  check("checkpoint_files 行数", db.countRows("checkpoint_files"), checkpointSource.reduce((total, item) => total + (item.files?.length ?? 0), 0));
  const lost = checkpointSource.filter((item) => JSON.stringify(checkpoints.get(item.conversationId)?.files) !== JSON.stringify(item.files));
  check("每个检查点的文件往返一致", lost.map((item) => item.conversationId), []);
} else {
  notes.push("--   checkpoints 没有旧文件");
}

// -- message queue --------------------------------------------------------------------
const queueFile = join(runtimeRoot, "message-queue.json");
const queueSource = readJson(queueFile);
if (existsSync(queueFile)) {
  const queue = new MessageQueueStore(db, { legacyFile: queueFile });
  const ids = (queueSource?.items ?? []).map((item) => item.id);
  check("queue 行数", db.countRows("queue_items"), ids.length);
  check("queue 顺序", queue.all(queue.conversationIds()[0] ?? "").map((item) => item.id).filter((id) => ids.includes(id)), ids.filter((id) => queue.all(queue.conversationIds()[0] ?? "").map((item) => item.id).includes(id)));
} else {
  notes.push("--   message-queue 没有旧文件");
}

// -- schedules ------------------------------------------------------------------------
const schedulesFile = join(runtimeRoot, "scheduled-tasks.json");
const scheduleSource = readJson(schedulesFile);
const schedules = new ScheduledTaskStore(db, { legacyFile: schedulesFile });
if (scheduleSource) {
  check("scheduled_tasks 行数", db.countRows("scheduled_tasks"), (scheduleSource.tasks ?? []).length);
  const expectedRuns = (scheduleSource.runs ?? []).filter((run) => (scheduleSource.tasks ?? []).some((task) => task.id === run.taskId));
  check("scheduled_runs 行数", db.countRows("scheduled_runs"), expectedRuns.length);
  check("每个任务往返一致", (scheduleSource.tasks ?? []).filter((task) => JSON.stringify(schedules.get(task.id)) !== JSON.stringify(task)).map((task) => task.id), []);
} else {
  notes.push("--   scheduled-tasks 没有旧文件");
}

// -- dag ------------------------------------------------------------------------------
const dagFile = join(dir, "dag.json");
const dagSource = readJson(dagFile);
if (dagSource) {
  const store = new DagStore(db, { resultsDir: join(dir, "dag.json.results"), legacyFile: dagFile });
  const graphIds = (dagSource.graphs ?? []).map((graph) => graph.conversationId);
  check("dag_graphs 行数", db.countRows("dag_graphs"), graphIds.length);
  check("dag_nodes 行数", db.countRows("dag_nodes"), (dagSource.graphs ?? []).reduce((total, graph) => total + (graph.nodes?.length ?? 0), 0));
  const lost = graphIds.filter((id) => store.get(id) === undefined);
  check("每张图都读得回来", lost, []);
  // 未结束的节点被标成 cancelled 是启动规则，不是丢数据：节点数必须一样。
  const shrunk = graphIds.filter((id) => (store.get(id)?.nodes.length ?? 0) !== (dagSource.graphs.find((graph) => graph.conversationId === id)?.nodes.length ?? -1));
  check("每张图的节点数一致", shrunk, []);
} else {
  notes.push("--   dag 没有旧文件");
}

// -- the imports were recorded, and the files were kept ------------------------------
const recorded = db.all("SELECT name, rows, status FROM legacy_imports ORDER BY name");
notes.push(`导入记录：${recorded.map((row) => `${row.name}=${row.rows}/${row.status}`).join(", ") || "（无）"}`);
const keptAside = readdirAll(dir).filter((name) => name.includes(".migrated-"));
notes.push(`改名保留的旧文件：${keptAside.length} 个`);
if (keptAside.length !== recorded.filter((row) => row.status === "imported").length) {
  problems.push(`保留的旧文件数与成功导入的 store 数不一致：${keptAside.length} vs ${recorded.filter((row) => row.status === "imported").length}`);
}
const reopened = db.get("SELECT 1 AS one")?.one;
check("重开数据库可用", reopened, 1);
notes.push(`数据库大小：${(statSync(dbFile).size / 1024).toFixed(1)} KB`);

closeDatabases();
console.log(notes.join("\n"));
if (problems.length > 0) {
  console.error(`\n${problems.length} 处不一致：\n${problems.join("\n")}`);
  if (!argv.includes("--keep")) rmSync(work, { recursive: true, force: true });
  process.exit(1);
}
console.log(`\n全部一致。副本：${argv.includes("--keep") ? work : "（已删除）"}`);
if (!argv.includes("--keep")) rmSync(work, { recursive: true, force: true });

function readdirAll(at, list = []) {
  for (const entry of readdirSync(at, { withFileTypes: true, recursive: true })) {
    list.push(entry.name);
  }
  return list;
}
