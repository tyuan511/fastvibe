#!/usr/bin/env node
/** Compare two JSON reports from scripts/bench-performance.mjs.
 *
 * The command always emits structured JSON on stdout. A Markdown rendering is optional
 * (`--markdown=artifacts/perf-comparison.md`) for humans. Exit status is non-zero when a
 * comparable metric regresses beyond its threshold, unless `--no-check` is supplied.
 *
 *   node scripts/compare-performance.mjs \
 *     --before=artifacts/perf-before.json --after=artifacts/perf-after.json \
 *     --json=artifacts/perf-comparison.json --markdown=artifacts/perf-comparison.md
 */
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const options = new Map();
for (let index = 2; index < process.argv.length; index += 1) {
  const item = process.argv[index];
  if (!item.startsWith("--")) continue;
  const body = item.slice(2);
  const at = body.indexOf("=");
  if (at >= 0) options.set(body.slice(0, at), body.slice(at + 1));
  else if (process.argv[index + 1] && !process.argv[index + 1].startsWith("--")) options.set(body, process.argv[++index]);
  else options.set(body, "true");
}

const beforeFile = resolve(options.get("before") ?? "artifacts/perf-before.json");
const afterFile = resolve(options.get("after") ?? "artifacts/perf-after.json");
const outOption = options.get("out");
const jsonFile = options.get("json") ?? (outOption && !outOption.endsWith(".md") ? outOption : undefined);
const markdownFile = options.get("markdown") ?? (outOption?.endsWith(".md") ? outOption : undefined);
const historyFile = options.has("history")
  ? resolve(options.get("history") === "true" ? "artifacts/perf-history.jsonl" : options.get("history"))
  : undefined;
const check = !options.has("no-check") && options.get("check") !== "false";
const explicitMemoryCheck = options.has("check-memory") && options.get("check-memory") !== "false";

const DEFAULT_THRESHOLDS = {
  wall: 20,
  cpu: 25,
  heap: 50,
  rss: 100,
  eventLoop: 20,
  p95: 50,
};
/** Tail percentiles from fewer samples than this are just the max, and too noisy to gate on. */
const MIN_TAIL_SAMPLES = 10;
/**
 * A regression must also be large in absolute terms. A 0.4 → 0.55 ms event-loop sample is
 * +33% and pure scheduler noise; relative thresholds alone flap on every sub-millisecond scenario.
 */
const DEFAULT_ABSOLUTE_FLOOR = { time: numberOptionEarly("min-delta-ms", 5), bytes: numberOptionEarly("min-delta-bytes", 1024 * 1024) };
function numberOptionEarly(name, fallback) {
  const value = Number(options.get(name));
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}
const METRICS = [
  { key: "medianMs", name: "wall", label: "wall" },
  { key: "p95Ms", name: "p95", label: "p95", tail: true },
  { key: "medianCpuMs", name: "cpu", label: "CPU" },
  { key: "medianHeapDelta", name: "heap", label: "heap Δ" },
  { key: "medianRssDelta", name: "rss", label: "RSS Δ" },
  { key: "medianEventLoopDelayMs", name: "eventLoop", label: "event-loop" },
];

function numberOption(name, fallback) {
  const value = Number(options.get(name));
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function readJson(file) {
  const value = JSON.parse(readFileSync(file, "utf8"));
  if (!value || !Array.isArray(value.results)) throw new Error(`Invalid performance report: ${file}`);
  return value;
}

function beforeNodeGcEnabled(report) {
  return Boolean(report?.node && typeof report.node === "object" && report.node.gcExposed === true);
}

function readThresholds() {
  const file = options.get("thresholds");
  let configured = {};
  if (file) {
    configured = JSON.parse(readFileSync(resolve(file), "utf8"));
    configured = configured.defaults ?? configured;
  }
  return {
    wall: numberOption("max-wall", configured.wall ?? DEFAULT_THRESHOLDS.wall),
    cpu: numberOption("max-cpu", configured.cpu ?? DEFAULT_THRESHOLDS.cpu),
    heap: numberOption("max-heap", configured.heap ?? DEFAULT_THRESHOLDS.heap),
    rss: numberOption("max-rss", configured.rss ?? DEFAULT_THRESHOLDS.rss),
    eventLoop: numberOption("max-event-loop", configured.eventLoop ?? DEFAULT_THRESHOLDS.eventLoop),
    p95: numberOption("max-p95", configured.p95 ?? DEFAULT_THRESHOLDS.p95),
  };
}

function finite(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function changePercent(before, after) {
  if (!finite(before) || !finite(after) || before === 0) return null;
  return ((after - before) / Math.abs(before)) * 100;
}

function metricComparisons(previous, current, thresholds, scenarioThresholds = {}, memoryCheck = false) {
  return Object.fromEntries(METRICS.map((metric) => {
    const before = previous?.[metric.key];
    const after = current?.[metric.key];
    const change = changePercent(before, after);
    const threshold = finite(scenarioThresholds[metric.name]) ? scenarioThresholds[metric.name] : thresholds[metric.name];
    const memoryMetric = metric.name === "heap" || metric.name === "rss";
    const tailTooSmall = metric.tail === true
      && ((previous?.samples?.length ?? 0) < MIN_TAIL_SAMPLES || (current?.samples?.length ?? 0) < MIN_TAIL_SAMPLES);
    const comparable = change !== null && (!memoryMetric || memoryCheck) && !tailTooSmall;
    const floor = memoryMetric ? DEFAULT_ABSOLUTE_FLOOR.bytes : DEFAULT_ABSOLUTE_FLOOR.time;
    const belowFloor = comparable && Math.abs(after - before) < floor;
    const regressed = comparable && change > threshold && !belowFloor;
    return [metric.name, {
      before: finite(before) ? before : null,
      after: finite(after) ? after : null,
      changePercent: change,
      thresholdPercent: threshold,
      comparable,
      reason: memoryMetric && !memoryCheck ? "memory-check-disabled" : tailTooSmall ? "too-few-samples" : belowFloor && change > threshold ? "below-absolute-floor" : null,
      regressed,
    }];
  }));
}

function format(value, suffix = "") {
  return value === null || value === undefined ? "—" : `${Number(value).toFixed(2)}${suffix}`;
}

function markdownReport(comparison) {
  const lines = [
    "# FastVibe 性能前后对比",
    "",
    `基线：${comparison.before.file}`,
    `改造：${comparison.after.file}`,
    `阈值检查：${comparison.check.enabled ? (comparison.check.passed ? "通过" : "失败") : "已禁用"}`,
    "",
    "| 场景 | wall 前 | wall 后 | wall 变化 | p95 前 | p95 后 | CPU 前 | CPU 后 | heap Δ 前 | heap Δ 后 | RSS Δ 前 | RSS Δ 后 | event-loop 前 | event-loop 后 | 状态 |",
    "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|",
  ];
  for (const row of comparison.rows) {
    const wall = row.metrics.wall;
    const cpu = row.metrics.cpu;
    const heap = row.metrics.heap;
    const rss = row.metrics.rss;
    const eventLoop = row.metrics.eventLoop;
    const status = row.status === "regression" ? "回归" : row.status === "new" ? "新增" : row.status === "removed" ? "移除" : "通过";
    const p95 = row.metrics.p95;
    lines.push(`| ${row.name} | ${format(wall.before)} | ${format(wall.after)} | ${format(wall.changePercent, "%")} | ${format(p95.before)} | ${format(p95.after)} | ${format(cpu.before)} | ${format(cpu.after)} | ${format(heap.before, " B")} | ${format(heap.after, " B")} | ${format(rss.before, " B")} | ${format(rss.after, " B")} | ${format(eventLoop.before, " ms")} | ${format(eventLoop.after, " ms")} | ${status} |`);
  }
  lines.push("", `回归阈值（相对变化）：wall ${comparison.thresholds.wall}%，CPU ${comparison.thresholds.cpu}%，heap ${comparison.thresholds.heap}%，RSS ${comparison.thresholds.rss}%，event-loop ${comparison.thresholds.eventLoop}%，p95 ${comparison.thresholds.p95}%（双方样本 ≥ ${MIN_TAIL_SAMPLES} 才参与门禁）；绝对变化小于 ${DEFAULT_ABSOLUTE_FLOOR.time} ms / ${(DEFAULT_ABSOLUTE_FLOOR.bytes / 1048576).toFixed(0)} MB 不计为回归。`, "负变化表示耗时或资源下降；RSS/heap 受 Node 分配器和运行顺序影响，应在同一机器上比较。", "");
  return lines.join("\n");
}

const before = readJson(beforeFile);
const after = readJson(afterFile);
const thresholds = readThresholds();
const memoryCheck = explicitMemoryCheck || (beforeNodeGcEnabled(before) && beforeNodeGcEnabled(after));
const beforeByName = new Map(before.results.map((item) => [item.name, item]));
const afterByName = new Map(after.results.map((item) => [item.name, item]));
const names = [...new Set([...before.results.map((item) => item.name), ...after.results.map((item) => item.name)])];
const configuredScenarioThresholds = (() => {
  const file = options.get("thresholds");
  if (!file) return {};
  const value = JSON.parse(readFileSync(resolve(file), "utf8"));
  return value.scenarios ?? {};
})();
const rows = names.map((name) => {
  const previous = beforeByName.get(name);
  const current = afterByName.get(name);
  const metrics = metricComparisons(previous, current, thresholds, configuredScenarioThresholds[name], memoryCheck);
  const regressions = Object.entries(metrics)
    .filter(([, metric]) => metric.regressed)
    .map(([metric]) => metric);
  const status = !previous ? "new" : !current ? "removed" : regressions.length > 0 ? "regression" : current.status === "skipped" ? "skipped" : "pass";
  return {
    name,
    status,
    beforeStatus: previous?.status ?? null,
    afterStatus: current?.status ?? null,
    regressions,
    metrics,
    before: previous ? { rounds: previous.rounds, samples: previous.samples?.length ?? 0 } : null,
    after: current ? { rounds: current.rounds, samples: current.samples?.length ?? 0 } : null,
  };
});
const regressions = rows.filter((row) => row.status === "regression").map((row) => ({ name: row.name, metrics: row.regressions }));
const comparison = {
  schema: 2,
  kind: "fastvibe-performance-comparison",
  generatedAt: new Date().toISOString(),
  before: { file: beforeFile, label: before.label ?? null, schema: before.schema ?? null, commit: before.source?.commit ?? null, node: before.node?.version ?? before.node ?? null },
  after: { file: afterFile, label: after.label ?? null, schema: after.schema ?? null, commit: after.source?.commit ?? null, node: after.node?.version ?? after.node ?? null },
  thresholds,
  rows,
  regressions,
  check: { enabled: check, memory: memoryCheck, passed: regressions.length === 0, exitCode: check && regressions.length > 0 ? 1 : 0 },
};

if (jsonFile) {
  const target = resolve(jsonFile);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, `${JSON.stringify(comparison, null, 2)}\n`);
  console.error(`wrote ${target}`);
}
if (markdownFile) {
  const target = resolve(markdownFile);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, `${markdownReport(comparison)}\n`);
  console.error(`wrote ${target}`);
}
if (historyFile) {
  mkdirSync(dirname(historyFile), { recursive: true });
  appendFileSync(historyFile, `${JSON.stringify(comparison)}\n`);
  console.error(`appended ${historyFile}`);
}
console.log(JSON.stringify(comparison, null, 2));
if (check && regressions.length > 0) process.exitCode = 1;
