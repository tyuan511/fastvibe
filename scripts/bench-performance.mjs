#!/usr/bin/env node
/**
 * Unified, repeatable FastVibe performance benchmark.
 *
 * The benchmark deliberately stays in Node and exercises the same Main/renderer pure
 * functions used by the app. It emits one JSON report on stdout; progress is stderr so
 * callers can pipe stdout to jq or save it verbatim.
 *
 * Examples:
 *   node scripts/bench-performance.mjs --label=before --json=artifacts/perf-before.json
 *   node --expose-gc scripts/bench-performance.mjs --label=after --json=artifacts/perf-after.json --history=artifacts/perf-history.jsonl
 */
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import * as os from "node:os";
import { cpus, freemem, totalmem } from "node:os";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";

const root = resolve(import.meta.dirname, "..");
const require = createRequire(import.meta.url);
const args = new Map();
for (let index = 2; index < process.argv.length; index += 1) {
  const item = process.argv[index];
  if (!item.startsWith("--")) continue;
  const body = item.slice(2);
  const at = body.indexOf("=");
  if (at >= 0) args.set(body.slice(0, at), body.slice(at + 1));
  else if (process.argv[index + 1] && !process.argv[index + 1].startsWith("--")) args.set(body, process.argv[++index]);
  else args.set(body, "true");
}
const label = args.get("label") ?? "run";
const jsonFile = args.get("json") ?? args.get("out");
const historyFile = args.has("history")
  ? (args.get("history") === "true" ? "artifacts/perf-history.jsonl" : args.get("history"))
  : undefined;
const gc = typeof global.gc === "function" ? global.gc : () => undefined;

const { EventBus } = await import(pathToFileURL(join(root, "src/main/app-server/event-bus.ts")).href);
const { openDatabase, closeDatabases } = await import(pathToFileURL(join(root, "src/main/engine/db.ts")).href);
const { CheckpointStore } = await import(pathToFileURL(join(root, "src/main/engine/checkpoint.ts")).href);
const { TranscriptReader } = await import(pathToFileURL(join(root, "src/main/engine/transcript-reader.ts")).href);
const { splitMarkdownBlocks } = await import(pathToFileURL(join(root, "src/renderer/src/lib/markdown-blocks.ts")).href);

function git(command, fallback = undefined) {
  try {
    return execFileSync("git", command, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || fallback;
  } catch {
    return fallback;
  }
}

function machineMetadata() {
  const processors = cpus();
  return {
    platform: os.platform(),
    release: os.release(),
    arch: os.arch(),
    endianness: os.endianness(),
    cpuCount: processors.length,
    cpuModel: processors[0]?.model ?? "unknown",
    cpuSpeedMHz: processors[0]?.speed ?? 0,
    totalMemoryBytes: totalmem(),
    freeMemoryBytes: freemem(),
  };
}

function sourceMetadata() {
  const commit = git(["rev-parse", "HEAD"]);
  return {
    root,
    commit,
    commitShort: commit?.slice(0, 12),
    branch: git(["branch", "--show-current"]),
    dirty: Boolean(git(["status", "--porcelain"])),
  };
}

function snapshotMemory() {
  const value = process.memoryUsage();
  return {
    rss: value.rss,
    heapUsed: value.heapUsed,
    heapTotal: value.heapTotal,
    external: value.external,
    arrayBuffers: value.arrayBuffers,
  };
}

function cpuMs() {
  const value = process.cpuUsage();
  return (value.user + value.system) / 1000;
}

function median(values) {
  const ordered = values.filter(Number.isFinite).sort((a, b) => a - b);
  return ordered.length === 0 ? null : ordered[Math.floor(ordered.length / 2)];
}

function min(values) {
  const ordered = values.filter(Number.isFinite);
  return ordered.length === 0 ? null : Math.min(...ordered);
}

function max(values) {
  const ordered = values.filter(Number.isFinite);
  return ordered.length === 0 ? null : Math.max(...ordered);
}

async function measure(name, fn, rounds = 5) {
  const samples = [];
  let result;
  for (let index = 0; index < rounds; index += 1) {
    gc();
    const beforeMemory = snapshotMemory();
    const beforeCpu = cpuMs();
    const loopDelay = monitorEventLoopDelay({ resolution: 10 });
    loopDelay.enable();
    const loopProbeStarted = performance.now();
    let loopProbeFinished = loopProbeStarted;
    const loopProbe = new Promise((resolveProbe) => setTimeout(() => {
      loopProbeFinished = performance.now();
      resolveProbe();
    }, 0));
    const started = performance.now();
    result = await fn(index);
    const elapsedMs = performance.now() - started;
    await Promise.all([loopProbe, new Promise((resolveNext) => setImmediate(resolveNext))]);
    loopDelay.disable();
    const eventLoopDelayMs = Math.max(0, loopProbeFinished - loopProbeStarted);
    const afterMemory = snapshotMemory();
    samples.push({
      elapsedMs,
      cpuMs: cpuMs() - beforeCpu,
      heapBefore: beforeMemory.heapUsed,
      heapAfter: afterMemory.heapUsed,
      heapDelta: afterMemory.heapUsed - beforeMemory.heapUsed,
      rssBefore: beforeMemory.rss,
      rssAfter: afterMemory.rss,
      rssDelta: afterMemory.rss - beforeMemory.rss,
      eventLoopDelayMs,
    });
  }
  const summary = {
    name,
    status: "ok",
    rounds,
    medianMs: median(samples.map((item) => item.elapsedMs)),
    medianCpuMs: median(samples.map((item) => item.cpuMs)),
    medianHeapDelta: median(samples.map((item) => item.heapDelta)),
    medianRssDelta: median(samples.map((item) => item.rssDelta)),
    medianRssAfter: median(samples.map((item) => item.rssAfter)),
    medianEventLoopDelayMs: median(samples.map((item) => item.eventLoopDelayMs)),
    minMs: min(samples.map((item) => item.elapsedMs)),
    maxMs: max(samples.map((item) => item.elapsedMs)),
    samples,
    ...(result && typeof result === "object" ? result : {}),
  };
  console.error(`${name}: ${summary.medianMs?.toFixed(2) ?? "—"}ms wall, ${summary.medianCpuMs?.toFixed(2) ?? "—"}ms CPU, heap Δ ${summary.medianHeapDelta ?? "—"} B, RSS Δ ${summary.medianRssDelta ?? "—"} B, event-loop ${summary.medianEventLoopDelayMs?.toFixed(2) ?? "—"}ms`);
  return summary;
}

async function optionalMeasure(name, fn, rounds = 3) {
  try {
    return await measure(name, fn, rounds);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`${name}: skipped (${message})`);
    return { name, status: "skipped", rounds: 0, error: message };
  }
}

function eventPayload(size = 32) {
  return {
    type: "message_update",
    conversationId: "bench-conversation",
    assistantMessageEvent: { type: "text_delta", delta: "x".repeat(size) },
  };
}

async function benchmarkEventBus() {
  const single = await measure("eventbus-single-scope-10k", () => {
    const bus = new EventBus({ maxPerScope: 512, maxBytes: 8 * 1024 * 1024 });
    const payload = eventPayload();
    for (let index = 0; index < 10_000; index += 1) bus.publish("conversation:hot", "engine:event", payload);
    return { events: 10_000 };
  }, 7);

  const multi = await measure("eventbus-512-scopes-hot-10k", () => {
    const bus = new EventBus({ maxPerScope: 512, maxScopes: 1024, maxBytes: 8 * 1024 * 1024 });
    const payload = eventPayload();
    for (let index = 0; index < 512; index += 1) bus.publish(`conversation:cold-${index}`, "engine:event", payload);
    for (let index = 0; index < 10_000; index += 1) bus.publish("conversation:hot", "engine:event", payload);
    return { coldScopes: 512, hotEvents: 10_000 };
  }, 5);

  const large = await measure("eventbus-4kb-payload-5k", () => {
    const bus = new EventBus({ maxPerScope: 512, maxBytes: 8 * 1024 * 1024 });
    const payload = eventPayload(4 * 1024);
    for (let index = 0; index < 5_000; index += 1) bus.publish("conversation:large", "engine:event", payload);
    return { events: 5_000, payloadBytes: 4 * 1024 };
  }, 5);
  return [single, multi, large];
}

async function benchmarkCheckpoint() {
  const work = mkdtempSync(join(tmpdir(), "fastvibe-perf-checkpoint-"));
  try {
    const repo = join(work, "repo");
    const source = join(repo, "src");
    mkdirSync(source, { recursive: true });
    execFileSync("git", ["init", "-q", repo]);
    const files = Array.from({ length: 32 }, (_, index) => ({
      path: join(source, `module-${index}.ts`),
      content: "x".repeat(8 * 1024),
      bytes: 8 * 1024,
    }));
    const db = openDatabase(join(work, "fastvibe.db"));
    const store = new CheckpointStore(db);
    try {
      return await measure("checkpoint-capture-32-incremental", async () => {
        for (let index = 0; index < files.length; index += 1) {
          await store.capture("bench", repo, files.slice(0, index + 1));
        }
        return { files: files.length, bytesPerFile: 8 * 1024 };
      }, 3);
    } finally {
      closeDatabases();
    }
  } finally {
    const absolute = resolve(work);
    if (!absolute.startsWith(resolve(tmpdir()))) throw new Error(`Refusing to remove unexpected path: ${absolute}`);
    rmSync(absolute, { recursive: true, force: true });
  }
}

function transcriptEntries(turns, textSize = 120) {
  const lines = [{ type: "session", version: 3, id: "session", timestamp: "2026-01-01T00:00:00.000Z", cwd: "/tmp/fastvibe-perf" }];
  let parentId = null;
  for (let index = 0; index < turns; index += 1) {
    const userId = `u-${index}`;
    lines.push({ type: "message", id: userId, parentId, timestamp: "2026-01-01T00:00:00.000Z", message: { role: "user", content: `prompt ${index}`, timestamp: index } });
    const assistantId = `a-${index}`;
    lines.push({ type: "message", id: assistantId, parentId: userId, timestamp: "2026-01-01T00:00:00.000Z", message: { role: "assistant", content: [{ type: "text", text: `answer ${index} ${"x".repeat(textSize)}` }], provider: "bench", model: "bench-model", stopReason: "stop", timestamp: index + 1, usage: { input: 100, output: 20, totalTokens: 120 } } });
    parentId = assistantId;
  }
  return lines;
}

function transcriptJsonl(turns, textSize = 120) {
  return transcriptEntries(turns, textSize).map((line) => JSON.stringify(line)).join("\n") + "\n";
}

async function benchmarkTranscriptJsonl() {
  const raw = transcriptJsonl(500);
  return measure("transcript-jsonl-500-turns", () => {
    const entries = raw.split("\n").filter(Boolean).map((line) => JSON.parse(line));
    return { bytes: Buffer.byteLength(raw), entries: entries.length };
  }, 7);
}

async function benchmarkTranscriptOpen() {
  const work = mkdtempSync(join(tmpdir(), "fastvibe-perf-transcript-"));
  try {
    const file = join(work, "session.jsonl");
    const raw = transcriptJsonl(500);
    writeFileSync(file, raw);
    return await measure("transcript-jsonl-500-turns-open", async () => {
      const reader = new TranscriptReader();
      const branch = await reader.read(file, work);
      return { bytes: Buffer.byteLength(raw), entries: branch.length };
    }, 5);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

async function loadProjection() {
  const ts = require("typescript");
  const source = require("node:fs").readFileSync(join(root, "src/main/pi/process-manager-transcript.ts"), "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const { sessionEntryToContextMessages } = await import("@earendil-works/pi-coding-agent");
  const { mapEngineMessages } = await import(pathToFileURL(join(root, "src/main/engine/map-messages.ts")).href);
  const { transcriptWindow, transcriptEntryEnd } = await import(pathToFileURL(join(root, "src/main/engine/transcript-window.ts")).href);
  const module = { exports: {} };
  const dependencies = {
    "@earendil-works/pi-coding-agent": { sessionEntryToContextMessages },
    "../engine/map-messages": { mapEngineMessages },
    "./tui-bridge": { renderExtensionMessage: () => undefined },
    "./process-manager-events": { isRecord: (value) => typeof value === "object" && value !== null },
    "../engine/transcript-window": { transcriptWindow, transcriptEntryEnd },
    "../engine/tool-images": { externalizeToolResultMessages: (messages) => messages },
  };
  new Function("module", "exports", "require", compiled)(module, module.exports, (name) => {
    if (name in dependencies) return dependencies[name];
    throw new Error(`Unexpected projection dependency: ${name}`);
  });
  return module.exports.projectSessionMessages;
}

async function benchmarkTranscriptAppend() {
  const work = mkdtempSync(join(tmpdir(), "fastvibe-perf-transcript-append-"));
  try {
    const file = join(work, "session.jsonl");
    const base = transcriptJsonl(500);
    const appended = transcriptJsonl(32).split("\n").filter(Boolean).map((line, index) => {
      const entry = JSON.parse(line);
      entry.id = `append-${index}`;
      return JSON.stringify(entry);
    }).join("\n") + "\n";
    const setup = async () => {
      writeFileSync(file, base);
      const reader = new TranscriptReader();
      await reader.readEntries(file, work);
      appendFileSync(file, appended);
      return reader;
    };
    const incremental = await measure("transcript-reader-append-incremental-32", async () => {
      const reader = await setup();
      const entries = await reader.readEntries(file, work);
      return { baseBytes: Buffer.byteLength(base), appendedBytes: Buffer.byteLength(appended), entries: entries.length, mode: "offset-append" };
    }, 5);
    const cold = await measure("transcript-reader-append-cold-reparse-32", async () => {
      await setup();
      const reader = new TranscriptReader();
      const entries = await reader.readEntries(file, work);
      return { baseBytes: Buffer.byteLength(base), appendedBytes: Buffer.byteLength(appended), entries: entries.length, mode: "full-reparse" };
    }, 5);
    return [incremental, cold];
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

async function benchmarkTranscriptProjection() {
  const projectSessionMessages = await loadProjection();
  const branch = transcriptEntries(300, 160);
  const deps = {
    branch,
    conversationId: "bench",
    reasoning: { get: () => undefined },
    widgetWidth: 80,
    running: new Map(),
    compacting: new Map(),
  };
  return measure("transcript-projection-300-turns", () => {
    const projected = projectSessionMessages(deps);
    return { entries: branch.length, messages: projected.messages.length };
  }, 5);
}

async function loadRendererProjection() {
  const ts = require("typescript");
  let source = readFileSync(join(root, "src/renderer/src/lib/group-parts.tsx"), "utf8");
  source = source.replace(/import \{ i18n \} from "@\/lib\/i18n";\n/, 'const i18n = { language: "en" };\n');
  source = source.replace(/^import .* from "\.\/tool-run";\n/m, "const collapseToolRuns = (parts) => parts; const runSummary = () => \"\";\n");
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  const temporary = join(root, "scripts", `.perf-group-parts-${process.pid}.mjs`);
  writeFileSync(temporary, compiled);
  try {
    return await import(`${pathToFileURL(temporary).href}?benchmark=${Date.now()}`);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function rendererMessages(turns) {
  const messages = [];
  for (let index = 0; index < turns; index += 1) {
    messages.push({ id: `u-${index}`, role: "user", text: `prompt ${index}`, tools: [], parts: [], createdAt: index });
    messages.push({ id: `a-${index}`, role: "assistant", text: `answer ${index}`, tools: [], parts: [], createdAt: index + 0.5 });
  }
  return messages;
}

async function benchmarkRendererProjection() {
  const { groupMessageRowsIncremental } = await loadRendererProjection();
  const baseline = rendererMessages(300);
  const full = await measure("renderer-rows-full-300-turns-120", () => {
    let messages = baseline;
    let projection;
    for (let index = 0; index < 120; index += 1) {
      messages = [...messages.slice(0, -1), { ...messages.at(-1), text: `answer tail ${index}` }];
      projection = groupMessageRowsIncremental(messages);
    }
    return { turns: 300, updates: 120, rows: projection.rows.length, turnsProjected: projection.turns.length, mode: "full" };
  }, 5);
  const incremental = await measure("renderer-rows-incremental-300-turns-120", () => {
    let messages = baseline;
    let projection = groupMessageRowsIncremental(messages);
    for (let index = 0; index < 120; index += 1) {
      messages = [...messages.slice(0, -1), { ...messages.at(-1), text: `answer tail ${index}` }];
      projection = groupMessageRowsIncremental(messages, projection);
    }
    return { turns: 300, updates: 120, rows: projection.rows.length, turnsProjected: projection.turns.length, mode: "incremental" };
  }, 5);
  return [full, incremental];
}

async function benchmarkRendererPureIncremental() {
  const settled = Array.from({ length: 40 }, (_, index) => `Paragraph ${index}: ${"stable text ".repeat(8)}`).join("\n\n");
  const updates = Array.from({ length: 120 }, (_, index) => `stream ${index}: ${"token ".repeat(12)}`).join("\n");
  return measure("renderer-markdown-blocks-incremental-120", () => {
    let blocks = [];
    let text = settled;
    for (const line of updates.split("\n")) {
      text += `\n${line}`;
      blocks = splitMarkdownBlocks(text);
    }
    return { updates: 120, blocks: blocks.length, bytes: Buffer.byteLength(text) };
  }, 5);
}

async function loadTranspiledEsm(relativeFile, tag) {
  const ts = require("typescript");
  const source = readFileSync(join(root, relativeFile), "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2019 },
  }).outputText;
  const temporary = join(root, "scripts", `.perf-${tag}-${process.pid}.mjs`);
  writeFileSync(temporary, compiled);
  try {
    return await import(`${pathToFileURL(temporary).href}?benchmark=${Date.now()}`);
  } finally {
    rmSync(temporary, { force: true });
  }
}

async function loadStreamingHighlighter() {
  return loadTranspiledEsm("src/renderer/src/lib/syntax-highlighter.ts", "syntax-highlighter");
}

async function benchmarkLatestOnlyQueue() {
  return optionalMeasure("latest-only-tool-delta-5k", async () => {
    const { ToolDeltaThrottle } = await loadTranspiledEsm("src/main/pi/tool-delta-throttle.ts", "tool-delta-throttle");
    let now = 0;
    const timers = new Map();
    let nextTimer = 0;
    const clock = {
      now: () => now,
      setTimeout: (run, ms) => {
        const id = ++nextTimer;
        timers.set(id, { run, at: now + ms });
        return id;
      },
      clearTimeout: (id) => timers.delete(id),
    };
    const throttle = new ToolDeltaThrottle(clock);
    let delivered = 0;
    for (let index = 0; index < 5_000; index += 1) {
      now += 1;
      for (const [id, timer] of [...timers]) {
        if (timer.at <= now) { timers.delete(id); timer.run(); }
      }
      throttle.offer("bench-owner", {
        type: "message_update",
        assistantMessageEvent: { type: "toolcall_delta", contentIndex: 0, delta: "x".repeat(40) },
      }, { seq: index }, () => { delivered += 1; });
    }
    throttle.release("bench-owner");
    return { offered: 5_000, delivered, dropped: 5_000 - delivered, latestOnly: true };
  }, 5);
}

async function benchmarkShikiQueue() {
  const ordered = await optionalMeasure("markdown-shiki-stream-queue-64", async () => {
    const { StreamingHighlighter } = await loadStreamingHighlighter();
    const highlighter = new StreamingHighlighter("typescript");
    let code = "";
    const pending = [];
    for (let index = 0; index < 64; index += 1) {
      code += `const value${index}: number = ${index};\n`;
      pending.push(highlighter.highlight(code));
    }
    const rendered = await Promise.all(pending);
    return { updates: pending.length, sourceBytes: Buffer.byteLength(code), outputBytes: Buffer.byteLength(rendered.at(-1) ?? ""), mode: "ordered" };
  }, 3);
  const latest = await optionalMeasure("markdown-shiki-latest-only-64", async () => {
    const { StreamingHighlighter } = await loadStreamingHighlighter();
    const highlighter = new StreamingHighlighter("typescript");
    let code = "";
    const pending = [];
    for (let index = 0; index < 64; index += 1) {
      code += `const value${index}: number = ${index};\n`;
      pending.push(highlighter.highlightLatest(code));
    }
    const rendered = await Promise.all(pending);
    return { updates: pending.length, sourceBytes: Buffer.byteLength(code), outputBytes: Buffer.byteLength(rendered.at(-1) ?? ""), mode: "latest-only" };
  }, 3);
  return [ordered, latest];
}

const startedAt = new Date().toISOString();
const results = [
  ...(await benchmarkEventBus()),
  await benchmarkCheckpoint(),
  await benchmarkTranscriptJsonl(),
  await benchmarkTranscriptOpen(),
  ...(await benchmarkTranscriptAppend()),
  await benchmarkTranscriptProjection(),
  ...(await benchmarkRendererProjection()),
  await benchmarkRendererPureIncremental(),
  await benchmarkLatestOnlyQueue(),
  ...(await benchmarkShikiQueue()),
];
const finishedAt = new Date().toISOString();
const report = {
  schema: 2,
  kind: "fastvibe-performance-report",
  label,
  startedAt,
  finishedAt,
  durationMs: Date.parse(finishedAt) - Date.parse(startedAt),
  node: {
    version: process.version,
    versions: process.versions,
    execPath: process.execPath,
    execArgv: process.execArgv,
    gcExposed: typeof global.gc === "function",
  },
  machine: machineMetadata(),
  source: sourceMetadata(),
  results,
};

if (jsonFile) {
  const target = resolve(jsonFile);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, `${JSON.stringify(report, null, 2)}\n`);
  console.error(`wrote ${target}`);
}
if (historyFile) {
  const target = resolve(historyFile);
  mkdirSync(dirname(target), { recursive: true });
  appendFileSync(target, `${JSON.stringify(report)}\n`);
  console.error(`appended ${target}`);
}
console.log(JSON.stringify(report, null, 2));
