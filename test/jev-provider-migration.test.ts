import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { FastVibePaths } from "../src/main/engine/paths.ts";
import * as types from "../src/shared/types.ts";
import * as decision from "../src/shared/decision.ts";
import * as order from "../src/shared/model-order.ts";
import * as urls from "../src/main/engine/provider-url.ts";
import * as modelApi from "../src/main/engine/model-api.ts";
import * as decisionStore from "../src/main/engine/decision/store.ts";

const require = createRequire(import.meta.url);
const ts = require("typescript") as typeof import("typescript");
const source = ts.transpileModule(readFileSync(new URL("../src/main/engine/providers.ts", import.meta.url), "utf8"), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;
const officialBase = "https://api.typesafe.ai/v1";
const model = (id = "jev-latest"): types.ProviderModel => ({
  id, name: id, contextWindow: 128000, maxTokens: 8192, reasoning: false, input: ["text"],
});
const response = () => new Response(JSON.stringify({ models: [{ name: "jev-latest" }, { name: "jev-preview" }] }));

// Use real provider/credential/config files. Only HTTP and unrelated SDK/catalog
// dependencies are replaced, so concurrent reads and writes exercise the real race.
function loadProviders(fetch: typeof globalThis.fetch) {
  const deps: Record<string, unknown> = {
    "@shared/types": types, "@shared/decision": decision, "@shared/model-order": order,
    "./provider-url": urls, "./model-api": modelApi, "./decision/store": decisionStore,
    "./models-dev": { catalogPrice: () => undefined, loadModelsDev: () => ({}), enrichModel: (_index: unknown, id: string) => model(id) },
    "./native-providers": { findNativeProvider: () => undefined },
    "./pi-global-sync.ts": {},
    "./gateway-probe": { isGatewayKind: () => false },
    "./oauth-store": { deleteOAuthCredential: () => undefined },
  };
  const exports = {};
  new Function("require", "exports", "fetch", source)((name: string) => {
    if (Object.hasOwn(deps, name)) return deps[name];
    if (name.startsWith("node:")) return require(name);
    throw new Error(`Unexpected provider dependency: ${name}`);
  }, exports, fetch);
  return exports as typeof import("../src/main/engine/providers.ts");
}

function fixture(t: test.TestContext, fetch: typeof globalThis.fetch = async () => response()) {
  const dir = mkdtempSync(join(tmpdir(), "fastvibe-jev-provider-"));
  const paths = {
    providersFile: join(dir, "providers.json"), agentEnv: join(dir, ".env"),
    decisionFile: join(dir, "decision.json"), oauthFile: join(dir, "oauth.json"),
  } as FastVibePaths;
  writeFileSync(paths.agentEnv, `${decision.JEV_KEY_ENV}=legacy-key\nOTHER_KEY=keep-me\n`);
  decisionStore.writeDecisionConfig(paths.decisionFile, { ...decision.DEFAULT_DECISION_MODEL, kind: "jev" });
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { paths, api: loadProviders(fetch) };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function blockedCatalog() {
  const started = deferred<void>();
  const reply = deferred<Response>();
  let calls = 0;
  const fetch: typeof globalThis.fetch = async () => { calls++; started.resolve(); return reply.promise; };
  return { fetch, started: started.promise, release: () => reply.resolve(response()), get calls() { return calls; } };
}

test("concurrent legacy callers fetch and create one Jev provider with a usable credential", async (t) => {
  const catalog = blockedCatalog();
  const { paths, api } = fixture(t, catalog.fetch);
  const runs = Array.from({ length: 6 }, () => api.adoptLegacyJevProvider({ ...paths }));
  await catalog.started;
  catalog.release();
  await Promise.all(runs);
  const jev = api.readProviders(paths).filter((p) => p.api === "systemone");
  assert.equal(jev.length, 1);
  assert.equal(catalog.calls, 1);
  assert.equal(jev[0].baseUrl, officialBase);
  assert.deepEqual(jev[0].models.map((m) => m.id), ["jev-latest", "jev-preview"]);
  const keys = await api.loadProviderKeys(paths);
  assert.equal(keys[jev[0].apiKeyEnv], "legacy-key");
  assert.equal(keys[decision.JEV_KEY_ENV], undefined);
  assert.equal(keys.OTHER_KEY, "keep-me");
  assert.deepEqual(decisionStore.readDecisionConfig(paths.decisionFile).model, { provider: jev[0].id, id: "jev-latest" });
  await api.adoptLegacyJevProvider(paths);
  assert.equal(catalog.calls, 1);
});

test("completion survives other provider edits and a restart, even after deleting Jev", async (t) => {
  const { paths, api } = fixture(t);
  await api.adoptLegacyJevProvider(paths);
  const jev = api.readProviders(paths).find((p) => p.api === "systemone")!;
  api.updateProvider(paths, jev.id, { name: "My Jev" });
  const other = await api.addProvider(paths, { name: "Other", baseUrl: "https://relay.test/v1", apiKey: "other-key" }, [model("chat")]);
  await api.removeProvider(paths, jev.id);
  await api.removeProvider(paths, other);
  const restarted = loadProviders(async () => { assert.fail("deleted Jev must not trigger a fetch"); });
  await restarted.adoptLegacyJevProvider(paths);
  assert.deepEqual(restarted.readProviders(paths).map((p) => p.id), ["fastvibe"]);
  assert.equal((await restarted.loadProviderKeys(paths))[decision.JEV_KEY_ENV], undefined);
});

test("an existing System One provider completes migration without replacing the selected relay model", async (t) => {
  const { paths, api } = fixture(t, async () => { assert.fail("existing provider must not trigger a fetch"); });
  const id = await api.addProvider(paths, { name: "My Jev", baseUrl: officialBase, api: "systemone", apiKey: "current-key" }, [model("jev-preview")]);
  api.updateProvider(paths, "fastvibe", { models: [{ ...model(), api: "systemone" }] });
  const selected = { provider: "fastvibe", id: "jev-latest" };
  decisionStore.writeDecisionConfig(paths.decisionFile, { ...decision.DEFAULT_DECISION_MODEL, kind: "jev", model: selected });
  await api.adoptLegacyJevProvider(paths);
  assert.deepEqual(decisionStore.readDecisionConfig(paths.decisionFile).model, selected);
  assert.equal((await api.loadProviderKeys(paths))[api.nativeKeyEnv(id)], "current-key");
  assert.equal((await api.loadProviderKeys(paths))[decision.JEV_KEY_ENV], undefined);
  assert.deepEqual(api.readProviders(paths).find((p) => p.id === id)!.models.map((m) => m.id), ["jev-preview"]);
  await api.removeProvider(paths, id);
  await loadProviders(async () => { assert.fail("migration must stay complete"); }).adoptLegacyJevProvider(paths);
  assert.equal(api.readProviders(paths).length, 1);
});

test("a provider added while the catalog is loading is reused with its own key and models", async (t) => {
  const catalog = blockedCatalog();
  const { paths, api } = fixture(t, catalog.fetch);
  const run = api.adoptLegacyJevProvider(paths);
  await catalog.started;
  const id = await api.addProvider(paths, { name: "Manual Jev", baseUrl: officialBase, api: "systemone", apiKey: "manual-key" }, [model("jev-preview")]);
  catalog.release();
  await run;
  const jev = api.readProviders(paths).filter((p) => p.api === "systemone");
  assert.deepEqual(jev.map((p) => p.id), [id]);
  assert.deepEqual(jev[0].models.map((m) => m.id), ["jev-preview"]);
  assert.equal((await api.loadProviderKeys(paths))[jev[0].apiKeyEnv], "manual-key");
});

test("deleting official Jev while its legacy catalog is loading prevents resurrection", async (t) => {
  const catalog = blockedCatalog();
  const { paths, api } = fixture(t, catalog.fetch);
  const run = api.adoptLegacyJevProvider(paths);
  await catalog.started;
  const id = await api.addProvider(paths, { name: "Jev", baseUrl: `${officialBase}/`, api: "systemone", apiKey: "manual-key" }, [model()]);
  await api.removeProvider(paths, id);
  catalog.release();
  await run;
  await api.adoptLegacyJevProvider(paths);
  assert.deepEqual(api.readProviders(paths).map((p) => p.id), ["fastvibe"]);
  assert.equal(catalog.calls, 1);
});

test("an unavailable catalog migrates the fallback once and keeps the decision engine usable", async (t) => {
  let calls = 0;
  const { paths, api } = fixture(t, async () => { calls++; throw new Error("offline"); });
  await Promise.all([api.adoptLegacyJevProvider(paths), api.adoptLegacyJevProvider(paths)]);
  await api.adoptLegacyJevProvider(paths);
  const jev = api.readProviders(paths).filter((p) => p.api === "systemone");
  assert.equal(jev.length, 1);
  assert.equal(calls, 1);
  assert.deepEqual(jev[0].models.map((m) => m.id), ["jev-latest"]);
  assert.equal((await api.loadProviderKeys(paths))[jev[0].apiKeyEnv], "legacy-key");
  assert.equal((await api.loadProviderKeys(paths))[decision.JEV_KEY_ENV], undefined);
});

test("no legacy key is a no-op, allowing migration if an old key is saved later", async (t) => {
  let calls = 0;
  const { paths, api } = fixture(t, async () => { calls++; return response(); });
  await api.setProviderKey(paths, decision.JEV_KEY_ENV, "");
  await api.adoptLegacyJevProvider(paths);
  assert.equal(calls, 0);
  await api.setProviderKey(paths, decision.JEV_KEY_ENV, "legacy-key");
  await api.adoptLegacyJevProvider(paths);
  assert.equal(calls, 1);
  assert.equal(api.readProviders(paths).filter((p) => p.api === "systemone").length, 1);
});

test("a failed write releases the migration so a subsequent call can retry", async (t) => {
  const { paths, api } = fixture(t);
  mkdirSync(paths.providersFile);
  await assert.rejects(api.adoptLegacyJevProvider(paths));
  assert.equal((await api.loadProviderKeys(paths))[decision.JEV_KEY_ENV], "legacy-key");
  rmSync(paths.providersFile, { recursive: true });
  await api.adoptLegacyJevProvider(paths);
  assert.equal(api.readProviders(paths).filter((p) => p.api === "systemone").length, 1);
});

test("an interrupted provider write recovers its credential before retiring the old key", async (t) => {
  const { paths, api } = fixture(t, async () => { assert.fail("existing provider must not be fetched again"); });
  const id = await api.addProvider(paths, { name: "Jev", baseUrl: officialBase, api: "systemone", apiKey: "" }, [model()]);
  await api.adoptLegacyJevProvider(paths);
  const keys = await api.loadProviderKeys(paths);
  assert.equal(keys[api.nativeKeyEnv(id)], "legacy-key");
  assert.equal(keys[decision.JEV_KEY_ENV], undefined);
  assert.equal(keys.OTHER_KEY, "keep-me");
});
