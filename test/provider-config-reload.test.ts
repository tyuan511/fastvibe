import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import * as piAi from "@earendil-works/pi-ai";
import * as piSdk from "@earendil-works/pi-coding-agent";
import * as piBuiltins from "@earendil-works/pi-ai/providers/all";
import type { FastVibePaths } from "../src/main/engine/paths.ts";

const require = createRequire(import.meta.url);
const ts = require("typescript") as typeof import("typescript");
const root = resolve(dirname(new URL(import.meta.url).pathname), "..");
const modules = new Map<string, unknown>();

// Resolve production modules' Vite aliases while retaining the real SDK runtime.
function load(file: string): any {
  const path = resolve(root, file.endsWith(".ts") ? file : `${file}.ts`);
  if (modules.has(path)) return modules.get(path);
  const exports = {};
  modules.set(path, exports);
  const output = ts.transpileModule(readFileSync(path, "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  new Function("require", "exports", output)((name: string) => {
    if (name === "@earendil-works/pi-ai") return piAi;
    if (name === "@earendil-works/pi-coding-agent") return piSdk;
    if (name === "@earendil-works/pi-ai/providers/all") return piBuiltins;
    // No native providers are configured in these fixtures.
    if (name === "./native-providers") return { findNativeProvider: () => undefined, listNativeProviders: () => [] };
    if (name.startsWith("@shared/")) return load(`src/shared/${name.slice(8)}`);
    if (name.startsWith(".")) return load(resolve(dirname(path), name));
    return require(name);
  }, exports);
  return exports;
}
const { globalPiModels } = load("src/main/engine/global-pi-providers");
const { uiText } = load("src/main/engine/ui-text");

const source = readFileSync(join(root, "src/main/pi/process-manager.ts"), "utf8");
const parsed = ts.createSourceFile("process-manager.ts", source, ts.ScriptTarget.Latest, true);
const wanted = new Set(["reloadProviders", "#rebindModels", "#rebindModel", "#flushModelRebind"]);
const methods: string[] = [];
function visit(node: import("typescript").Node): void {
  if (ts.isMethodDeclaration(node) && wanted.has(node.name.getText(parsed))) methods.push(node.getText(parsed));
  ts.forEachChild(node, visit);
}
visit(parsed);
assert.equal(methods.length, wanted.size);
const compiled = ts.transpileModule(`class Harness { ${methods.join("\n").replaceAll("#", "")} }`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText;
const Harness = new Function("globalPiModels", "modelPriceIndex", "uiText", `${compiled}; return Harness;`)(
  globalPiModels,
  () => new Map(),
  uiText,
);

const provider = "external-reload-test";
function writeModels(paths: FastVibePaths, baseUrl: string, ids = ["chat"]): void {
  writeFileSync(paths.modelsJson, JSON.stringify({ providers: { [provider]: {
    api: "openai-completions", baseUrl,
    models: ids.map((id) => ({ id, name: id, reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 8192 })),
  } } }));
}
function writeKey(paths: FastVibePaths, key: string): void {
  writeFileSync(paths.oauthFile, JSON.stringify({ [provider]: { type: "api_key", key } }));
}
async function fixture(t: test.TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "fv-provider-reload-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const paths = { engineMode: "global", modelsJson: join(dir, "models.json"), oauthFile: join(dir, "auth.json") } as FastVibePaths;
  writeModels(paths, "https://old.example.test/v1");
  writeKey(paths, "test-old-key");
  const runtime = await piSdk.ModelRuntime.create({
    authPath: paths.oauthFile, modelsPath: paths.modelsJson,
    modelsStore: new piAi.InMemoryModelsStore(), allowModelNetwork: false, refreshOnCreate: false,
  });
  const registry = new piSdk.ModelRegistry(runtime);
  await registry.refresh({ allowNetwork: false });
  assert.equal(registry.getError(), undefined);
  const host = Object.assign(new Harness(), {
    paths, runtime, models: registry, status: { state: "ready" },
    sessions: new Map(), modelDirty: new Set(), pendingMcpReloads: new Set(),
    openAIQuotaCache: new Map([[provider, "cached"]]), gatewayBalanceCache: new Map([[provider, "cached"]]),
    imageToolsVersion: 0,
    imageModelsChanged: () => undefined,
    scheduleMcpReload: async () => undefined,
    queue: async (task: () => Promise<unknown>) => task(),
    isImageModel: () => false,
    start: () => assert.fail("A configuration reload must not restart the engine"),
  });
  return { paths, runtime, registry, host };
}

test("manual reload applies externally changed global models and credentials on the same runtime", async (t) => {
  const { paths, runtime, registry, host } = await fixture(t);
  assert.equal((await runtime.getAuth(provider))?.auth.apiKey, "test-old-key");
  const previous = registry.find(provider, "chat");
  assert.ok(previous);
  writeModels(paths, "https://new.example.test/v1", ["chat", "added"]);
  writeKey(paths, "test-new-key");

  await host.reloadProviders();

  assert.strictEqual(host.runtime, runtime);
  assert.strictEqual(host.models, registry);
  assert.equal(registry.getError(), undefined);
  assert.equal(registry.find(provider, "chat")?.baseUrl, "https://new.example.test/v1");
  assert.notStrictEqual(registry.find(provider, "chat"), previous);
  assert.deepEqual(host.modelsCache.filter((model: { provider: string }) => model.provider === provider).map((model: { id: string }) => model.id).sort(), ["added", "chat"]);
  assert.equal((await runtime.getAuth(provider))?.auth.apiKey, "test-new-key");
  assert.equal(host.openAIQuotaCache.size, 0);
  assert.equal(host.gatewayBalanceCache.size, 0);

  writeModels(paths, "https://new.example.test/v1", ["added"]);
  await host.reloadProviders();
  assert.equal(registry.find(provider, "chat"), undefined);
  assert.deepEqual(host.modelsCache.filter((model: { provider: string }) => model.provider === provider).map((model: { id: string }) => model.id), ["added"]);
});

test("manual reload rejects invalid models JSON, preserves the last cache, and recovers after repair", async (t) => {
  const { paths, runtime, registry, host } = await fixture(t);
  await host.reloadProviders();
  const previousCache = host.modelsCache;
  const previousContents = structuredClone(previousCache);
  assert.deepEqual(previousCache.filter((model: { provider: string }) => model.provider === provider).map((model: { id: string }) => model.id), ["chat"]);

  writeFileSync(paths.modelsJson, '{"providers":');
  await assert.rejects(
    () => host.reloadProviders(),
    { name: "Error", message: uiText("模型配置加载失败，请检查配置后重试。", "Could not load model configuration. Check it and try again.") },
  );
  assert.strictEqual(host.modelsCache, previousCache);
  assert.deepEqual(host.modelsCache, previousContents);

  writeModels(paths, "https://repaired.example.test/v1", ["recovered"]);
  await host.reloadProviders();

  assert.strictEqual(host.runtime, runtime);
  assert.strictEqual(host.models, registry);
  assert.equal(registry.getError(), undefined);
  assert.notStrictEqual(host.modelsCache, previousCache);
  assert.deepEqual(host.modelsCache.filter((model: { provider: string }) => model.provider === provider).map((model: { id: string }) => model.id), ["recovered"]);
  assert.equal(registry.find(provider, "chat"), undefined);
  assert.equal(registry.find(provider, "recovered")?.baseUrl, "https://repaired.example.test/v1");
});

test("reload quietly rebinds idle sessions and defers streaming sessions until their turn ends", async (t) => {
  const { paths, registry, host } = await fixture(t);
  const previous = registry.find(provider, "chat");
  assert.ok(previous);
  const clamped: string[] = [];
  const session = (id: string, streaming: boolean) => ({
    get model() { return this.agent.state.model; },
    agent: { state: { model: previous } },
    isStreaming: streaming, isIdle: !streaming, thinkingLevel: "off",
    setThinkingLevel: () => clamped.push(id),
    setModel: () => assert.fail("Refreshing the same model must not append a model switch"),
    dispose: () => assert.fail("Reload must preserve live sessions"),
    abort: () => assert.fail("Reload must not abort a streaming reply"),
  });
  const idle = session("idle", false);
  const streaming = session("streaming", true);
  host.sessions.set("idle", { session: idle });
  host.sessions.set("streaming", { session: streaming });
  writeModels(paths, "https://new.example.test/v1");

  await host.reloadProviders();

  const refreshed = registry.find(provider, "chat");
  assert.deepEqual(idle.model, refreshed);
  assert.notStrictEqual(idle.model, previous);
  assert.strictEqual(streaming.model, previous);
  assert.deepEqual(clamped, ["idle"]);
  assert.equal(host.modelDirty.has("streaming"), true);
  assert.equal(host.sessions.size, 2);
  await host.flushModelRebind("streaming");
  assert.strictEqual(streaming.model, previous);
  streaming.isStreaming = false;
  await host.flushModelRebind("streaming");
  assert.deepEqual(streaming.model, refreshed);
  assert.notStrictEqual(streaming.model, previous);
  assert.deepEqual(clamped, ["idle", "streaming"]);
  assert.equal(host.modelDirty.size, 0);
});
