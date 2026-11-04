import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, mkdirSync, writeFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import * as piAi from "@earendil-works/pi-ai";
import * as piSdk from "@earendil-works/pi-coding-agent";
import * as piBuiltins from "@earendil-works/pi-ai/providers/all";
import { InMemoryModelsStore } from "@earendil-works/pi-ai";
import { ModelRuntime, ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { FastVibePaths } from "../src/main/engine/paths.ts";
import type { ProviderConfig, ProviderModel } from "../src/shared/types.ts";
import { imageModelKey, imageModelsFromProviders, imageProtocolForApi, isImageApi, isUsableImageModel } from "../src/shared/image-model.ts";
import { piProviderModelsEntry, writePiAgentConfig } from "../src/main/engine/pi-global-sync.ts";

test("image model usability requires enabled generic key, valid endpoint and model identifiers", () => {
  const model = { id: "p/image", model: "image", name: "Image", protocol: "openai" as const, baseUrl: "https://example.invalid/v1", enabled: true, hasKey: true };
  assert.equal(isUsableImageModel(model), true);
  assert.equal(isUsableImageModel({ ...model, baseUrl: "http://localhost:3000/v1" }), true);
  for (const patch of [{ enabled: false }, { hasKey: false }, { id: " " }, { model: "\n" }, { model: " image" }, { baseUrl: "file:///tmp/image" }, { baseUrl: "https://" }, { baseUrl: "https://key:secret@example.invalid" }]) {
    assert.equal(isUsableImageModel({ ...model, ...patch }), false, JSON.stringify(patch));
  }
});

// Run production provider modules with Node's real SDK. Transpile only to resolve
// the application's extensionless and @shared imports outside the Vite build.
const require = createRequire(import.meta.url);
const ts = require("typescript") as typeof import("typescript");
const root = resolve(dirname(new URL(import.meta.url).pathname), "..");
const cache = new Map<string, unknown>();
function load(file: string): any {
  const path = resolve(root, file.endsWith(".ts") ? file : `${file}.ts`);
  if (cache.has(path)) return cache.get(path);
  const output = ts.transpileModule(readFileSync(path, "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const exports = {};
  cache.set(path, exports);
  new Function("require", "exports", output)((name: string) => {
    if (name === "@earendil-works/pi-ai") return piAi;
    if (name === "@earendil-works/pi-coding-agent") return piSdk;
    if (name === "@earendil-works/pi-ai/providers/all") return piBuiltins;
    if (name === "./models-dev") return {
      loadModelsDev: () => ({}), catalogPrice: () => undefined,
      enrichModel: (_index: unknown, id: string, name: string) => model(id, { name }),
    };
    if (name === "./gateway-probe") return { isGatewayKind: () => false, probeGateway: async () => undefined };
    if (name.startsWith("@shared/")) return load(`src/shared/${name.slice(8)}`);
    if (name.startsWith(".")) return load(resolve(dirname(path), name));
    return require(name);
  }, exports);
  return exports;
}
const providers = load("src/main/engine/providers") as typeof import("../src/main/engine/providers.ts");
const globalProviders = load("src/main/engine/global-pi-providers") as typeof import("../src/main/engine/global-pi-providers.ts");
const nativeProviders = load("src/main/engine/native-providers") as typeof import("../src/main/engine/native-providers.ts");

function model(id: string, extra: Partial<ProviderModel> = {}): ProviderModel {
  return { id, name: id, contextWindow: 128000, maxTokens: 8192, reasoning: false, input: ["text"], ...extra };
}
function provider(extra: Record<string, unknown> = {}): ProviderConfig {
  return { id: "image-demo", kind: "custom", name: "Demo", api: "image-gpt", baseUrl: "https://example.test/v1", apiKeyEnv: "KEY", hasKey: true, hasOAuth: false, supportsKey: true, enabled: true, models: [model("picture")], ...extra } as ProviderConfig;
}
function fixture(t: test.TestContext, global = false): FastVibePaths {
  const dir = mkdtempSync(join(tmpdir(), "fv-image-provider-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const paths = {
    engineMode: global ? "global" : "isolated", providersFile: join(dir, "providers.json"),
    agentEnv: join(dir, ".env"), modelsJson: join(dir, "models.json"), oauthFile: join(dir, "auth.json"),
    isolatedAgentDir: dir,
  } as FastVibePaths;
  mkdirSync(dir, { recursive: true });
  return paths;
}
async function registryFor(paths: FastVibePaths): Promise<ModelRegistry> {
  const runtime = await ModelRuntime.create({ authPath: paths.oauthFile, modelsPath: paths.modelsJson,
    modelsStore: new InMemoryModelsStore(), allowModelNetwork: false, refreshOnCreate: false });
  const registry = new ModelRegistry(runtime);
  assert.equal(registry.getError(), undefined);
  return registry;
}

test("image protocol projection honours model overrides and retains provider credentials and endpoint", () => {
  assert.equal(isImageApi("image-gpt"), true);
  assert.equal(isImageApi("google-generative-ai"), false);
  assert.equal(imageProtocolForApi("image-grok"), "grok");
  assert.equal(imageProtocolForApi("image-gemini"), "gemini");
  assert.equal(imageProtocolForApi("openai-responses"), undefined);
  assert.equal(imageModelKey("p", "namespace/m"), "p/namespace/m");
  const projected = imageModelsFromProviders([provider({ models: [model("picture"), model("chat", { api: "openai-responses" })] })]);
  assert.deepEqual(projected, [{ id: "image-demo/picture", name: "picture", model: "picture", protocol: "openai", providerId: "image-demo", baseUrl: "https://example.test/v1", enabled: true, hasKey: true }]);
});

test("isolated image-only credentials remain usable and mixed providers expose only chat models", async (t) => {
  const paths = fixture(t);
  const id = await providers.addProvider(paths, { name: "Demo", baseUrl: "https://example.test/v1", api: "image-gpt", apiKey: "fake-key" }, [model("picture")]);
  assert.equal(providers.usableProviders(paths, await providers.loadProviderKeys(paths)).length, 1);
  assert.deepEqual(providers.applyProviders(paths), []);
  let registry = await registryFor(paths);
  assert.equal(registry.getAll().some((m) => m.provider === id), false);
  providers.updateProvider(paths, id, { models: [model("picture"), model("chat", { api: "openai-responses" })] });
  assert.deepEqual(providers.applyProviders(paths).map((m) => m.id), ["chat"]);
  registry = await registryFor(paths);
  assert.deepEqual(registry.getAll().filter((m) => m.provider === id).map((m) => [m.id, m.api]), [["chat", "openai-responses"]]);
  assert.equal(providers.readProviders(paths)[0].api, "image-gpt");
});

test("native image overrides survive save, reload and catalog refresh, including noncatalog ids", async (t) => {
  const paths = fixture(t);
  const native = nativeProviders.findNativeProvider("openai")!;
  const existing = native.models[0];
  const images = [model(existing.id, { api: "image-gpt" }), model("private-image", { api: "image-gemini" })];
  await providers.addNativeProvider(paths, "openai", "fake-key", images);
  assert.deepEqual(providers.readProviders(paths)[0].models.map((m) => m.api), ["image-gpt", "image-gemini"]);
  const refreshed = await providers.refreshProviderModels(paths, "openai");
  assert.equal(refreshed.find((m) => m.id === existing.id)?.api, "image-gpt");
  assert.equal(refreshed.find((m) => m.id === "private-image")?.api, "image-gemini");
  providers.updateProvider(paths, "openai", { models: images });
  assert.deepEqual(providers.applyProviders(paths), []);
  await registryFor(paths);
});

test("global edits round-trip image models and reproject when provider api changes", async (t) => {
  const paths = fixture(t, true);
  const p = provider({ models: [model("picture"), model("chat", { api: "openai-responses" })] });
  globalProviders.updateGlobalPiProvider(paths, p, ["name", "baseUrl", "api", "models"]);
  await globalProviders.setGlobalPiKey(paths, p.id, "fake-key");
  let registry = await registryFor(paths);
  assert.deepEqual(registry.getAll().filter((m) => m.provider === p.id).map((m) => m.id), ["chat"]);
  let saved = globalProviders.readGlobalPiProviders(paths).find((item) => item.id === p.id)!;
  assert.equal(saved.api, "image-gpt");
  assert.equal(saved.models.length, 2);
  globalProviders.updateGlobalPiProvider(paths, { ...saved, api: "openai-completions" }, ["api"]);
  registry = await registryFor(paths);
  assert.deepEqual(registry.getAll().filter((m) => m.provider === p.id).map((m) => m.id).sort(), ["chat", "picture"]);
  saved = globalProviders.readGlobalPiProviders(paths).find((item) => item.id === p.id)!;
  globalProviders.updateGlobalPiProvider(paths, { ...saved, api: "image-grok", models: saved.models.map((m) => ({ ...m, api: undefined })) }, ["api", "models"]);
  registry = await registryFor(paths);
  assert.equal(registry.getAll().some((m) => m.provider === p.id), false);
  assert.equal(globalProviders.readGlobalPiProviders(paths).find((item) => item.id === p.id)?.models.length, 2);
});

test("global native model converted to image is excluded from chat menu after real SDK loading", async (t) => {
  const paths = fixture(t, true);
  const native = nativeProviders.findNativeProvider("openai")!;
  const selected = model(native.models[0].id, { api: "image-gpt", edited: true });
  const p = { ...provider(), id: "openai", kind: "native" as const, api: native.api, baseUrl: native.baseUrl, models: [selected] };
  globalProviders.updateGlobalPiProvider(paths, p, ["models"]);
  await globalProviders.setGlobalPiKey(paths, p.id, "fake-key");
  const registry = await registryFor(paths);
  assert.ok(registry.find("openai", selected.id), "SDK retains its built-in chat catalog");
  assert.equal(globalProviders.globalPiModels(registry, paths).some((m) => m.provider === "openai" && m.id === selected.id), false);
  assert.equal(globalProviders.readGlobalPiProviders(paths).find((item) => item.id === "openai")?.models.find((m) => m.id === selected.id)?.api, "image-gpt");
});

test("image discovery inherits the image protocol and custom refresh preserves image overrides", async (t) => {
  const paths = fixture(t);
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  let requested = "";
  globalThis.fetch = (async (url: string | URL | Request) => {
    requested = String(url);
    return Response.json({ models: [{ name: "models/gemini-picture" }] });
  }) as typeof fetch;
  const discovered = await providers.fetchProviderModels("https://example.test/v1", "fake-key", "image-gemini");
  assert.match(requested, /\/v1beta\/models\?/);
  assert.equal(discovered[0].id, "gemini-picture");
  assert.equal(discovered[0].api, undefined, "image default must not be inferred as a Gemini chat override");
  const id = await providers.addProvider(paths, { name: "Images", baseUrl: "https://example.test/v1", apiKey: "fake-key" }, [model("gemini-picture", { api: "image-gemini" }), model("private", { api: "image-grok" })]);
  globalThis.fetch = (async () => Response.json({ data: [{ id: "gemini-picture" }] })) as typeof fetch;
  const refreshed = await providers.refreshProviderModels(paths, id);
  assert.deepEqual(refreshed.map((m) => [m.id, m.api]), [["gemini-picture", "image-gemini"], ["private", "image-grok"]]);
});

test("sync writes image extensions through the shared builder without invalid SDK api fields", async (t) => {
  const paths = fixture(t, true);
  const p = provider();
  writePiAgentConfig(dirname(paths.modelsJson), { providers: [{ id: p.id, kind: "custom", models: piProviderModelsEntry(p, "fake-key") }], skipped: [], mcp: [] });
  const registry = await registryFor(paths);
  assert.equal(registry.getAll().some((m) => m.provider === p.id), false);
  assert.equal(globalProviders.readGlobalPiProviders(paths)[0].api, "image-gpt");
});

function writeKeyFixture(paths: FastVibePaths, apiKey?: string, credential?: unknown, id = "image-demo"): void {
  writeFileSync(paths.modelsJson, JSON.stringify({ providers: { [id]: {
    ...piProviderModelsEntry(provider({ id }), apiKey),
  } } }));
  writeFileSync(paths.oauthFile, JSON.stringify(credential ? { [id]: credential } : {}));
}

test("real SDK resolves image-only provider keys with empty SDK models", async (t) => {
  const paths = fixture(t, true);
  writeKeyFixture(paths, "models-key");
  let registry = await registryFor(paths);
  assert.equal(registry.getAll().some((m) => m.provider === "image-demo"), false);
  assert.equal(await registry.getApiKeyForProvider("image-demo"), "models-key");
  writeKeyFixture(paths, "models-key", { type: "api_key", key: "auth-key" });
  registry = await registryFor(paths);
  assert.equal(await registry.getApiKeyForProvider("image-demo"), "auth-key");
  assert.equal(await globalProviders.resolveGlobalPiImageKey(paths, "image-demo"), "auth-key");
  // A custom provider cannot consume OAuth. Its stored credential nevertheless
  // blocks the SDK's configured key, so the image resolver needs its own path.
  writeKeyFixture(paths, "models-key", { type: "oauth", access: "never-use", refresh: "never-refresh", expires: 0 });
  registry = await registryFor(paths);
  assert.equal(await registry.getApiKeyForProvider("image-demo"), undefined);
  assert.equal(await globalProviders.resolveGlobalPiImageKey(paths, "image-demo"), "models-key");
});

test("global image keys use SDK literal, escaped, env and command expressions from either file", async (t) => {
  const paths = fixture(t, true);
  const envName = "FASTVIBE_TEST_IMAGE_RESOLVER_KEY";
  const previous = process.env[envName];
  process.env[envName] = "env-key";
  t.after(() => { if (previous === undefined) delete process.env[envName]; else process.env[envName] = previous; });
  for (const [expression, expected] of [
    ["literal-key", "literal-key"], ["$!literal$$key", "!literal$key"],
    [`$${envName}`, "env-key"], [`prefix-${"${" + envName + "}"}`, "prefix-env-key"],
    ["!printf 'command-key'", "command-key"],
  ]) {
    writeKeyFixture(paths, expression);
    const registry = await registryFor(paths);
    assert.equal(await registry.getApiKeyForProvider("image-demo"), expected);
    assert.equal(await globalProviders.resolveGlobalPiImageKey(paths, "image-demo"), expected);
    writeKeyFixture(paths, "lower-priority-key", { type: "api_key", key: expression });
    assert.equal(await globalProviders.resolveGlobalPiImageKey(paths, "image-demo"), expected);
  }
  writeKeyFixture(paths, "models-key", { type: "api_key", key: `$${envName}`, env: { [envName]: "credential-env-key" } });
  assert.equal(await globalProviders.resolveGlobalPiImageKey(paths, "image-demo"), "credential-env-key");
  for (const expression of ["$FASTVIBE_TEST_IMAGE_MISSING_KEY", "!exit 1", ""]) {
    writeKeyFixture(paths, "must-not-fallback", { type: "api_key", key: expression });
    assert.equal(await globalProviders.resolveGlobalPiImageKey(paths, "image-demo"), undefined);
    writeKeyFixture(paths, expression);
    assert.equal(await globalProviders.resolveGlobalPiImageKey(paths, "image-demo"), undefined);
  }
});

test("global image key resolution never refreshes OAuth, sends tokens or writes files", async (t) => {
  const paths = fixture(t, true);
  const originalFetch = globalThis.fetch;
  let networkCalls = 0;
  globalThis.fetch = (async () => { networkCalls++; throw new Error("Image key resolution must not access the network"); }) as typeof fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const oauth = { type: "oauth", access: "never-use", refresh: "never-refresh", expires: 0 };
  for (const id of ["image-demo", "openai", "openai-codex"]) {
    writeKeyFixture(paths, "explicit-key", oauth, id);
    const files = readdirSync(dirname(paths.modelsJson)).sort();
    const authBefore = readFileSync(paths.oauthFile, "utf8");
    assert.equal(await globalProviders.resolveGlobalPiImageKey(paths, id), "explicit-key");
    assert.deepEqual(readdirSync(dirname(paths.modelsJson)).sort(), files);
    assert.equal(readFileSync(paths.oauthFile, "utf8"), authBefore);
  }
  writeKeyFixture(paths, undefined, oauth);
  assert.equal(await globalProviders.resolveGlobalPiImageKey(paths, "image-demo"), undefined);
  assert.equal(await globalProviders.resolveGlobalPiImageKey(paths, "missing-provider"), undefined);
  assert.equal(networkCalls, 0);
});

test("native API-key environment is a generic fallback even with stored OAuth", async (t) => {
  const paths = fixture(t, true);
  const previous = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "native-env-key";
  t.after(() => { if (previous === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = previous; });
  writeKeyFixture(paths, undefined, { type: "oauth", access: "never-use", refresh: "never-refresh", expires: 0 }, "openai");
  assert.equal(await globalProviders.resolveGlobalPiImageKey(paths, "openai"), "native-env-key");
  writeKeyFixture(paths, "models-key", undefined, "openai");
  assert.equal(await globalProviders.resolveGlobalPiImageKey(paths, "openai"), "models-key");
  writeKeyFixture(paths, "models-key", { type: "api_key", key: "stored-key" }, "openai");
  assert.equal(await globalProviders.resolveGlobalPiImageKey(paths, "openai"), "stored-key");
});
