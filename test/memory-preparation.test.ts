import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import test from "node:test";
import type { MemoryManager } from "../src/main/engine/memory.ts";
import type { FastVibePaths } from "../src/main/engine/paths.ts";
import * as config from "../src/shared/memory.ts";
import * as protocol from "../src/main/engine/decision/protocol.ts";
import * as dispatch from "../src/main/engine/decision/dispatch.ts";
import * as backend from "../src/main/engine/decision/backends/jev.ts";
import * as runtime from "../src/main/engine/decision/runtime.ts";
import * as trace from "../src/main/engine/decision/trace.ts";
import * as decisionStore from "../src/main/engine/decision/store.ts";
import * as store from "../src/main/engine/memory-store.ts";
import * as tools from "../src/main/engine/memory-tools.ts";
import * as download from "../src/main/engine/memory-download.ts";
import * as modelSource from "../src/main/engine/memory-model-source.ts";
import * as budget from "../src/main/engine/memory-read-budget.ts";
import * as jev from "../src/main/engine/memory-jev.ts";

const require = createRequire(import.meta.url);
const ts = require("typescript") as typeof import("typescript");
// Exercise the whole real manager, including SQLite and DecisionRuntime. Only the
// credential resolver, model inference and HTTP are replaced; no Electron or network.
const source = ts.transpileModule(readFileSync(new URL("../src/main/engine/memory.ts", import.meta.url), "utf8"), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function responseFor(questions: Record<string, unknown>, value: (key: string) => number): Response {
  return new Response(JSON.stringify({ answers: Object.fromEntries(Object.keys(questions).map((key) => [key, { type: "noul", noul: value(key) }])), model: "fake" }));
}

function fixture(t: Parameters<Parameters<typeof test>[1]>[0], options: {
  cached?: boolean;
  modelWait?: Promise<unknown>;
  embedWait?: Promise<unknown>;
  resolveWait?: Promise<unknown>;
  maxEdges?: number;
  multiHop?: number;
  reply?: (request: { state: Record<string, unknown>; questions: Record<string, unknown> }, signal: AbortSignal) => Promise<Response>;
} = {}) {
  const dir = mkdtempSync(join(tmpdir(), "fastvibe-memory-preparation-"));
  const paths = {
    memoryFile: join(dir, "memory.json"), memoryDatabaseFile: join(dir, "memory.sqlite"),
    memoryModelsDir: join(dir, "models"), decisionFile: join(dir, "decision.json"), decisionTraceFile: join(dir, "trace.jsonl"),
  } as FastVibePaths;
  mkdirSync(paths.memoryModelsDir);
  writeFileSync(paths.memoryFile, JSON.stringify({ enabled: true, mode: "jev", autoCapture: false, maxResults: 1, systemTwoModel: { provider: "fake", id: "fake" } }));
  writeFileSync(paths.decisionFile, JSON.stringify({ version: 1, decisionModel: { kind: "jev", memoryControl: true, model: { provider: "fake", id: "fake" } } }));
  if (options.cached !== false) {
    for (const file of ["config.json", "tokenizer.json", "tokenizer_config.json", `onnx/${modelSource.MEMORY_MODEL_FILE}.onnx`]) {
      const p = join(paths.memoryModelsDir, modelSource.MEMORY_MODEL_ID, file);
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, "{}");
    }
  }
  const modelCalls: Array<{ model: string; options: Record<string, unknown> }> = [];
  const calls: string[] = [];
  const requests: Array<{ state: Record<string, unknown>; questions: Record<string, unknown> }> = [];
  const signals: AbortSignal[] = [];
  let embeds = 0;
  const deps: Record<string, unknown> = {
    "@shared/memory": config, "./decision/protocol": protocol, "./decision/dispatch": dispatch,
    "./decision/runtime": runtime, "./decision/trace": trace, "./decision/store": decisionStore,
    "./memory-store": store, "./memory-tools": tools, "./memory-download": download,
    "./memory-model-source": modelSource, "./memory-read-budget": budget,
    "./memory-jev": { ...jev, JEV_MEM_PROFILE: { ...jev.JEV_MEM_PROFILE, maximumEdges: options.maxEdges ?? jev.JEV_MEM_PROFILE.maximumEdges } },
    "./ui-text": { uiText: (_zh: string, en: string) => en },
    "./decision/systemone": { resolveSystemOne: async () => { await options.resolveWait; return { apiKey: "fake", endpoint: "https://memory.test/v1/systemone", model: "fake" }; } },
    "./decision/backends/jev": { ...backend, createJevBackend: (resolved: Parameters<typeof backend.createJevBackend>[0]) => backend.createJevBackend({
      ...resolved,
      fetch: async (_url, init) => {
        const request = JSON.parse(init!.body as string);
        requests.push(request);
        calls.push(Object.keys(request.questions).join(","));
        signals.push(init!.signal as AbortSignal);
        if (options.reply) return options.reply(request, init!.signal as AbortSignal);
        const answers = Object.fromEntries(Object.keys(request.questions).map((key) => [key, { type: "noul", noul: key === "multi_hop_need" ? options.multiHop ?? 0 : key === "semantic" || key === "continue_useful" || key.endsWith("_relevance") ? 1 : 0 }]));
        return new Response(JSON.stringify({ answers, model: "fake" }));
      },
    }) },
    "@huggingface/transformers": { pipeline: async (_task: string, model: string, opts: Record<string, unknown>) => {
      modelCalls.push({ model, options: opts });
      await options.modelWait;
      return async () => { embeds++; await options.embedWait; return { tolist: () => [[1, 0]] }; };
    } },
  };
  const exports: { MemoryManager?: typeof MemoryManager } = {};
  new Function("require", "exports", source)((name: string) => {
    if (Object.prototype.hasOwnProperty.call(deps, name)) return deps[name];
    if (name.startsWith("node:") || name === "typebox") return require(name);
    throw new Error(`Unexpected memory dependency: ${name}`);
  }, exports);
  const manager = new exports.MemoryManager!(paths);
  const db = new store.MemoryStore(paths.memoryDatabaseFile);
  t.after(() => { manager.close(); db.close(); rmSync(dir, { recursive: true, force: true }); });
  const seed = (id = "anchor", project = "project", content = "FastVibe memory latency", embedding: number[] | null = [1, 0]) => db.upsert({
    id, project, conversationId: "chat", role: "user", kind: "fact", content, createdAt: 1, importance: 1, confidence: 1,
  }, embedding ?? undefined);
  return { manager, db, seed, paths, calls, requests, signals, modelCalls, get embeds() { return embeds; } };
}

test("cached models load from a local directory without metadata probes or download progress", async (t) => {
  const f = fixture(t); f.seed();
  await f.manager.search({ query: "FastVibe", project: "project" });
  assert.equal(f.modelCalls.length, 1);
  assert.equal(f.modelCalls[0].model, join(f.paths.memoryModelsDir, modelSource.MEMORY_MODEL_ID));
  assert.equal(f.modelCalls[0].options.local_files_only, true);
  assert.equal(f.modelCalls[0].options.progress_callback, undefined);
});

test("missing models never download during retrieval; explicit preparation still can download", async (t) => {
  const f = fixture(t, { cached: false }); f.seed();
  assert.equal((await f.manager.search({ query: "FastVibe", project: "project" })).items.length, 1);
  assert.equal(f.modelCalls.length, 0);
  await f.manager.prepareModel();
  assert.equal(f.modelCalls[0].model, modelSource.MEMORY_MODEL_ID);
  assert.equal(f.modelCalls[0].options.local_files_only, false);
});

test("empty project and conversation scopes skip model loading and all JEV calls", async (t) => {
  const f = fixture(t); f.seed("other", "other-project");
  for (const scope of [{ project: "project" }, { conversationId: "another-chat" }]) {
    assert.deepEqual((await f.manager.search({ query: "FastVibe", ...scope })).items, []);
  }
  assert.equal(f.modelCalls.length, 0);
  assert.equal(f.calls.length, 0);
});

test("model loading is inside the read deadline and cannot start late embedding or JEV work", async (t) => {
  const loaded = deferred<void>();
  const f = fixture(t, { modelWait: loaded.promise }); f.seed();
  const start = performance.now();
  const result = await f.manager.search({ query: "FastVibe", project: "project" }, { timeoutMs: 30, strategy: "context" });
  assert.deepEqual(result.items.map((item) => item.id), ["anchor"]);
  assert.ok(performance.now() - start < 500);
  loaded.resolve();
  await f.manager.ensureModel();
  assert.equal(f.embeds, 0);
  assert.equal(f.calls.length, 0);
});

test("embedding is bounded and a late result does not start JEV", async (t) => {
  const embedded = deferred<void>();
  const f = fixture(t, { embedWait: embedded.promise }); f.seed();
  const result = await f.manager.search({ query: "FastVibe", project: "project" }, { timeoutMs: 30, strategy: "context" });
  assert.equal(result.items[0].id, "anchor");
  assert.equal(result.usedEmbedding, false);
  embedded.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.calls.length, 0);
});

test("a stalled JEV route is aborted at the total deadline and preserves hybrid local hits", async (t) => {
  const f = fixture(t, { reply: async (_request, signal) => new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true })) });
  f.seed();
  f.seed("vector-only", "project", "unrelated wording");
  const result = await f.manager.search({ query: "FastVibe", project: "project", limit: 2 }, { timeoutMs: 40 });
  assert.deepEqual(result.items.map((item) => item.id).sort(), ["anchor", "vector-only"]);
  assert.equal(result.usedEmbedding, true);
  assert.equal(result.usedJev, false);
  assert.equal(f.calls.length, 1);
  assert.equal(f.signals[0].aborted, true);
});

test("cancelled reads promptly release model waits and cannot start a later request", async (t) => {
  const loaded = deferred<void>();
  const f = fixture(t, { modelWait: loaded.promise }); f.seed();
  const stop = new AbortController();
  const pending = f.manager.search({ query: "FastVibe", project: "project" }, { signal: stop.signal, strategy: "context" });
  await new Promise((resolve) => setImmediate(resolve));
  stop.abort();
  assert.equal((await pending).items[0].id, "anchor");
  loaded.resolve(); await f.manager.ensureModel();
  assert.equal(f.calls.length, 0);
  assert.equal(f.embeds, 0);
});

test("credential resolution shares the read deadline", async (t) => {
  const resolved = deferred<void>();
  const f = fixture(t, { resolveWait: resolved.promise }); f.seed();
  const result = await f.manager.search({ query: "FastVibe", project: "project" }, { timeoutMs: 30 });
  assert.equal(result.items[0].id, "anchor");
  resolved.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.calls.length, 0);
});

test("the depth limit prevents a final assessment request after the last expansion", async (t) => {
  const f = fixture(t); f.seed();
  f.seed("neighbor", "project", "different topic", [0.7, 0.7]);
  f.db.addEdge({ sourceId: "anchor", targetId: "neighbor", view: "semantic", relation: "related", weight: 1 });
  await f.manager.search({ query: "FastVibe", project: "project" });
  assert.equal(f.calls.length, 2, "route and a combined assessment/traversal; no request past depth 1");
  assert.equal(f.calls.filter((keys) => keys.startsWith("evidence_sufficient")).length, 1);
});

test("the edge limit prevents another assessment even when depth and node budgets remain", async (t) => {
  const f = fixture(t, { maxEdges: 1, multiHop: 1 }); f.seed();
  f.seed("neighbor", "project", "different topic", [0.7, 0.7]);
  f.db.addEdge({ sourceId: "anchor", targetId: "neighbor", view: "semantic", relation: "related", weight: 1 });
  await f.manager.search({ query: "FastVibe", project: "project" });
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls.filter((keys) => keys.startsWith("evidence_sufficient")).length, 1);
});

test("automatic context uses one request to select a graph-only hit, deduplicated and scoped", async (t) => {
  const f = fixture(t, { reply: async (request) => {
    const candidates = request.state.candidates as Array<{ id: string }>;
    return responseFor(request.questions, (key) => {
      const match = /^candidate_(\d+)_relevance$/.exec(key);
      return match && candidates[Number(match[1])].id === "answer" ? 1 : 0;
    });
  } });
  f.seed();
  f.seed("answer", "project", "Previously chosen deployment: Singapore", null);
  f.seed("private", "other-project", "Other project private note", null);
  for (const targetId of ["answer", "private"]) {
    for (const view of ["semantic", "entity"] as const) f.db.addEdge({ sourceId: "anchor", targetId, view, relation: "related", weight: 1 });
  }
  const text = await f.manager.contextPrompt({ query: "FastVibe", project: "project" });
  assert.match(text, /chosen deployment: Singapore/);
  assert.doesNotMatch(text, /FastVibe memory latency|private note/);
  assert.equal(f.calls.length, 1);
  const ids = (f.requests[0].state.candidates as Array<{ id: string }>).map((node) => node.id);
  assert.deepEqual(ids, ["anchor", "answer"]);
  assert.equal(f.requests[0].questions.semantic, undefined);
  assert.equal(f.requests[0].questions.evidence_sufficient, undefined);
});

test("automatic candidate selection bounds dense graphs at forty unique memories", async (t) => {
  const f = fixture(t); f.seed();
  for (let i = 0; i < 60; i++) f.seed(`local${i}`, "project", "FastVibe memory latency");
  for (let i = 0; i < 40; i++) {
    const id = `graph${i}`;
    f.seed(id, "project", "additional linked context", null);
    f.db.addEdge({ sourceId: "anchor", targetId: id, view: "semantic", relation: "related", weight: 1 });
  }
  await f.manager.contextPrompt({ query: "FastVibe", project: "project" });
  assert.equal(f.calls.length, 1);
  const candidates = f.requests[0].state.candidates as Array<{ id: string }>;
  assert.equal(candidates.length, 40);
  assert.equal(new Set(candidates.map((item) => item.id)).size, 40);
});

test("automatic JEV failure falls back immediately without a retry request", async (t) => {
  const f = fixture(t, { reply: async () => new Response("overloaded", { status: 503 }) }); f.seed();
  const start = performance.now();
  assert.match(await f.manager.contextPrompt({ query: "FastVibe", project: "project" }), /FastVibe memory latency/);
  assert.equal(f.calls.length, 1);
  assert.ok(performance.now() - start < 450, "a single-call context budget must not wait for retry backoff");
});

test("a valid single-shot answer can reject all candidates without reinjecting the local fallback", async (t) => {
  const f = fixture(t, { reply: async (request) => responseFor(request.questions, () => 0) }); f.seed();
  assert.equal(await f.manager.contextPrompt({ query: "FastVibe", project: "project" }), "");
  assert.equal(f.calls.length, 1);
});

test("manual routing runs while embedding is still pending", { timeout: 2_000 }, async (t) => {
  const embedded = deferred<void>(), routeEntered = deferred<void>();
  const f = fixture(t, { embedWait: embedded.promise, reply: async (request) => {
    routeEntered.resolve();
    return responseFor(request.questions, (key) => key === "semantic" ? 1 : 0);
  } });
  f.seed();
  let finished = false;
  const pending = f.manager.search({ query: "FastVibe", project: "project" }).then((result) => { finished = true; return result; });
  await routeEntered.promise;
  assert.equal(f.calls.length, 1);
  assert.equal(finished, false);
  embedded.resolve();
  assert.equal((await pending).items[0].id, "anchor");
  assert.equal(f.calls.length, 1, "no assessment is needed when there are no graph proposals");
});

test("cancellation aborts speculative routing as well as the model wait", { timeout: 2_000 }, async (t) => {
  const loaded = deferred<void>(), routeEntered = deferred<void>();
  const f = fixture(t, { modelWait: loaded.promise, reply: async (_request, signal) => {
    routeEntered.resolve();
    return new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
  } });
  f.seed();
  const stop = new AbortController();
  const pending = f.manager.search({ query: "FastVibe", project: "project" }, { signal: stop.signal });
  await routeEntered.promise;
  stop.abort();
  assert.equal((await pending).items[0].id, "anchor");
  assert.equal(f.signals[0].aborted, true);
  loaded.resolve(); await f.manager.ensureModel();
  assert.equal(f.embeds, 0);
  assert.equal(f.calls.length, 1);
});

test("manual retrieval still discovers evidence two hops away with one combined call per hop", async (t) => {
  const f = fixture(t, { reply: async (request) => responseFor(request.questions, (key) => {
    if (key === "multi_hop_need") return 0.25;
    if (key === "semantic" || key === "continue_useful" || key === "missing_evidence") return 1;
    if (key.startsWith("candidate_")) return key.endsWith("_relevance") && request.state.depth === 0 ? 0.6 : 1;
    return 0;
  }) });
  f.seed("anchor", "project", "FastVibe rollout links to project Delta", [0.4, 0.9165]);
  f.seed("bridge", "project", "Delta decision refers to the approved deployment", null);
  f.seed("answer", "project", "Approved deployment: Singapore", null);
  for (const [sourceId, targetId] of [["anchor", "bridge"], ["bridge", "answer"]]) f.db.addEdge({ sourceId, targetId, view: "semantic", relation: "related", weight: 1 });
  const result = await f.manager.search({ query: "FastVibe rollout", project: "project" });
  assert.equal(result.items[0].id, "answer");
  assert.equal(f.calls.length, 3);
  assert.deepEqual(f.requests.slice(1).map((request) => request.state.depth), [0, 1]);
  for (const request of f.requests.slice(1)) {
    assert.ok(request.questions.evidence_sufficient);
    assert.ok(request.questions.candidate_0_relevance);
  }
});

test("a combined stopping answer discards speculative scores and prevents later hops", async (t) => {
  const f = fixture(t, { reply: async (request) => responseFor(request.questions, (key) => {
    return key === "semantic" || key === "multi_hop_need" || key === "evidence_sufficient" || key.startsWith("candidate_") ? 1 : 0;
  }) });
  f.seed("anchor", "project", "FastVibe decision", [0.4, 0.9165]);
  f.seed("neighbor", "project", "next hop", null);
  f.db.addEdge({ sourceId: "anchor", targetId: "neighbor", view: "semantic", relation: "related", weight: 1 });
  const result = await f.manager.search({ query: "FastVibe", project: "project" });
  assert.equal(result.items[0].id, "anchor");
  assert.equal(f.calls.length, 2);
});

test("automatic context preparation has a shorter budget than an explicit search", async (t) => {
  const loaded = deferred<void>();
  const f = fixture(t, { modelWait: loaded.promise }); f.seed();
  const start = performance.now();
  assert.match(await f.manager.contextPrompt({ query: "FastVibe", project: "project" }), /FastVibe memory latency/);
  const elapsed = performance.now() - start;
  assert.ok(elapsed >= budget.MEMORY_PREPARATION_TIMEOUT_MS - 100 && elapsed < budget.MEMORY_PREPARATION_TIMEOUT_MS + 1000);
  const stop = new AbortController();
  let finished = false;
  const manual = f.manager.search({ query: "FastVibe", project: "project" }, { signal: stop.signal }).then((result) => { finished = true; return result; });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(finished, false, "the automatic timeout must not poison the shared model loader or shorten a later manual search");
  stop.abort();
  assert.equal((await manual).items[0].id, "anchor");
  loaded.resolve(); await f.manager.ensureModel();
});
