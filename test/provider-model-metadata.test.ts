import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { FastVibePaths } from "../src/main/engine/paths.ts";
import * as types from "../src/shared/types.ts";
import * as order from "../src/shared/model-order.ts";
import * as urls from "../src/main/engine/provider-url.ts";
import * as modelApi from "../src/main/engine/model-api.ts";

/**
 * Where a stored model's metadata comes from.
 *
 * `providers.json` keeps a copy of every field the catalog supplied — context window,
 * output ceiling, modalities, price — and reading a provider used to trust that copy for
 * good. The copy is only what the snapshot said on the day the model was added, so an
 * install outlived the catalog: when the folding rules changed which reseller's entry won
 * (see `test/models-dev-index.test.ts`), every existing provider kept the old winner's
 * context window and price and nothing ever corrected it.
 *
 * Only a row the user tuned (`edited`) is authoritative. Everything else is re-derived
 * from the catalog on every read, and a model the catalog does not describe at all keeps
 * what it had — replacing a real context window with the 128K default would make the
 * window guard compact far too early.
 */
const require = createRequire(import.meta.url);
const ts = require("typescript") as typeof import("typescript");
const source = ts.transpileModule(readFileSync(new URL("../src/main/engine/providers.ts", import.meta.url), "utf8"), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;

/** What the current snapshot says about the ids these cases use. */
const CATALOG: Record<string, { contextWindow: number; maxTokens: number; cost: types.ModelPrice["cost"] }> = {
  "claude-sonnet-5-5": { contextWindow: 1_000_000, maxTokens: 128_000, cost: { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 } },
};

function loadProviders() {
  const deps: Record<string, unknown> = {
    "@shared/types": types,
    "@shared/model-order": order,
    "./provider-url": urls,
    "./model-api": modelApi,
    "./models-dev": {
      catalogPrice: () => undefined,
      loadModelsDev: () => ({}),
      enrichModel: (_index: unknown, id: string, name: string) => {
        const known = CATALOG[id];
        if (!known) {
          return {
            id, name, contextWindow: 128_000, maxTokens: 8_192, reasoning: false, input: ["text"], source: "default",
          } satisfies types.ProviderModel;
        }
        return {
          id,
          name,
          contextWindow: known.contextWindow,
          maxTokens: known.maxTokens,
          reasoning: true,
          input: ["text", "image"],
          thinkingLevels: ["low", "medium", "high"],
          cost: known.cost,
          source: "models.dev",
        } satisfies types.ProviderModel;
      },
    },
    "./native-providers": {
      findNativeProvider: () => undefined,
      listNativeProviders: () => [],
      mergeNativeModels: (_id: string, models: unknown) => models,
      selectedNativeModels: (_id: string, models: unknown) => models,
    },
    "./pi-global-sync.ts": { piProviderModelsEntry: () => undefined },
    "./gateway-probe": { isGatewayKind: () => false },
    "./oauth-store": { deleteOAuthCredential: () => undefined, readOAuthProviderIds: () => new Set<string>() },
  };
  const exports = {};
  new Function("require", "exports", source)((name: string) => {
    if (Object.hasOwn(deps, name)) return deps[name];
    if (name.startsWith("node:")) return require(name);
    throw new Error(`Unexpected provider dependency: ${name}`);
  }, exports);
  return exports as typeof import("../src/main/engine/providers.ts");
}

/** A stored row as an older snapshot wrote it — the wrong winner's numbers. */
function storedModel(id: string, extra: Record<string, unknown> = {}): types.ProviderModel {
  return {
    id,
    name: id,
    contextWindow: 200_000,
    maxTokens: 64_000,
    reasoning: false,
    input: ["text"],
    cost: { input: 99, output: 99, cacheRead: 0, cacheWrite: 0 },
    source: "models.dev",
    ...extra,
  } as types.ProviderModel;
}

function fixture(t: test.TestContext, models: unknown[]) {
  const dir = mkdtempSync(join(tmpdir(), "fastvibe-model-metadata-"));
  const paths = {
    providersFile: join(dir, "providers.json"),
    agentEnv: join(dir, ".env"),
    oauthFile: join(dir, "oauth.json"),
    modelsJson: join(dir, "models.json"),
  } as FastVibePaths;
  const provider = {
    id: "relay",
    kind: "custom",
    name: "Relay",
    baseUrl: "https://relay.example/v1",
    api: "openai-completions",
    apiKeyEnv: "KEY_RELAY",
    enabled: true,
    models,
  };
  writeFileSync(paths.providersFile, `${JSON.stringify({ version: 3, providers: [provider] }, null, 2)}\n`);
  writeFileSync(paths.agentEnv, "KEY_RELAY=key\n");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { paths, api: loadProviders() };
}

test("an untouched model takes the catalog's current limits and price", (t) => {
  const { paths, api } = fixture(t, [storedModel("claude-sonnet-5-5")]);
  const model = api.readProviders(paths)[0]?.models[0];
  assert.equal(model?.contextWindow, 1_000_000, "not the 200K an earlier snapshot's winner had");
  assert.equal(model?.maxTokens, 128_000);
  assert.equal(model?.reasoning, true);
  assert.deepEqual(model?.input, ["text", "image"]);
  assert.deepEqual(model?.cost, { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 });
});

test("a model tuned in 模型详情 keeps every field the user chose", (t) => {
  const tuned = storedModel("claude-sonnet-5-5", {
    name: "快模型",
    contextWindow: 150_000,
    maxTokens: 16_000,
    thinkingLevels: ["medium"],
    cost: { input: 7, output: 8, cacheRead: 0, cacheWrite: 0 },
    edited: true,
  });
  const { paths, api } = fixture(t, [tuned]);
  const model = api.readProviders(paths)[0]?.models[0];
  assert.equal(model?.name, "快模型");
  assert.equal(model?.contextWindow, 150_000);
  assert.equal(model?.maxTokens, 16_000);
  assert.deepEqual(model?.thinkingLevels, ["medium"]);
  assert.deepEqual(model?.cost, { input: 7, output: 8, cacheRead: 0, cacheWrite: 0 });
});

test("a model the catalog has never heard of keeps what it was stored with", (t) => {
  const { paths, api } = fixture(t, [storedModel("acme-internal-1")]);
  const model = api.readProviders(paths)[0]?.models[0];
  assert.equal(model?.contextWindow, 200_000, "the 128K default would compact far too early");
  assert.equal(model?.maxTokens, 64_000);
  assert.deepEqual(model?.cost, { input: 99, output: 99, cacheRead: 0, cacheWrite: 0 });
});
