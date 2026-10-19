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
 * The 决策引擎 is gone, and with it the `systemone` API format it existed for. A
 * `providers.json` written by those builds can still carry a provider whose own protocol
 * was System One, and `hydrateProvider` repairs an unknown `api` to `openai-completions`.
 * Without the drop below, that repair turns a decision endpoint into a chat provider whose
 * models surface in the composer and fail on every request — silently. These cases pin the
 * one rule that keeps it from happening: such an entry is dropped, never repaired.
 */
const require = createRequire(import.meta.url);
const ts = require("typescript") as typeof import("typescript");
const source = ts.transpileModule(readFileSync(new URL("../src/main/engine/providers.ts", import.meta.url), "utf8"), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;

const model = (id: string): types.ProviderModel => ({
  id, name: id, contextWindow: 128000, maxTokens: 8192, reasoning: false, input: ["text"],
});

function loadProviders() {
  const deps: Record<string, unknown> = {
    "@shared/types": types,
    "@shared/model-order": order,
    "./provider-url": urls,
    "./model-api": modelApi,
    "./models-dev": { catalogPrice: () => undefined, loadModelsDev: () => ({}), enrichModel: (_index: unknown, id: string) => model(id) },
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

function fixture(t: test.TestContext, providers: unknown[]) {
  const dir = mkdtempSync(join(tmpdir(), "fastvibe-retired-systemone-"));
  const paths = {
    providersFile: join(dir, "providers.json"),
    agentEnv: join(dir, ".env"),
    oauthFile: join(dir, "oauth.json"),
    modelsJson: join(dir, "models.json"),
  } as FastVibePaths;
  writeFileSync(paths.providersFile, `${JSON.stringify({ version: 3, providers }, null, 2)}\n`);
  writeFileSync(paths.agentEnv, "KEY_PACKY=key\n");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { paths, api: loadProviders() };
}

const custom = {
  id: "packy",
  kind: "custom",
  name: "Packy",
  baseUrl: "https://packy.example/v1",
  api: "openai-completions",
  apiKeyEnv: "KEY_PACKY",
  enabled: true,
  models: [model("gpt-x")],
};

const officialJev = {
  id: "jev",
  kind: "custom",
  name: "Jev",
  baseUrl: "https://api.typesafe.ai/v1",
  api: "systemone",
  apiKeyEnv: "KEY_JEV",
  enabled: true,
  models: [model("jev-latest")],
};

test("a provider that spoke the removed decision protocol is dropped, not read as a chat provider", (t) => {
  const { paths, api } = fixture(t, [officialJev, custom]);
  const live = api.readProviders(paths);
  assert.deepEqual(live.map((item) => item.id), ["packy"], "only the real chat provider survives");
  assert.ok(!live.some((item) => (item as { api?: string }).api === "systemone"));
});

test("the dropped entry cannot come back on the next write", async (t) => {
  const { paths, api } = fixture(t, [officialJev, custom]);
  await api.addProvider(paths, { name: "New relay", baseUrl: "https://new.example/v1", apiKey: "k", api: "openai-completions" }, [model("m")]);
  const written = JSON.parse(readFileSync(paths.providersFile, "utf8")) as { providers: Array<{ id: string; api?: string }> };
  assert.deepEqual(written.providers.map((item) => item.id), ["packy", written.providers[1]?.id]);
  assert.ok(!readFileSync(paths.providersFile, "utf8").includes("systemone"), "the retired protocol is not copied forward");
  assert.deepEqual(api.readProviders(paths).map((item) => item.id), written.providers.map((item) => item.id));
});

test("a chat provider that merely pinned a decision model keeps the provider and inherits its protocol", (t) => {
  const pinned = { ...custom, models: [{ ...model("gpt-x"), api: "systemone" }, model("gpt-y")] };
  const { paths, api } = fixture(t, [pinned]);
  const live = api.readProviders(paths);
  assert.equal(live.length, 1, "the provider itself is not the decision endpoint, so it stays");
  assert.equal(live[0]?.api, "openai-completions");
  assert.deepEqual(
    live[0]?.models.map((item) => item.api),
    [undefined, undefined],
    "a protocol the app no longer offers falls back to the provider's own",
  );
});
