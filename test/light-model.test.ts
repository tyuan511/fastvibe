import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lightModelFor, pinnedLightModel, type LightModelRegistry } from "../src/main/engine/light-model.ts";
import { readLightModel, invalidateAppSettingsCache } from "../src/main/engine/runtime-settings.ts";
import type { FastVibePaths } from "../src/main/engine/paths.ts";

/**
 * 轻量模型: the rule that turns one setting into the model a side job runs on.
 *
 * These four jobs (a chat's title, a commit subject, the next-message guess, memory
 * extraction) each ask for a model separately, so the order they agree on is the thing
 * worth pinning: a pin is a preference, never a hard requirement, and a job must still
 * run when the pin is gone.
 */

type Model = { provider: string; id: string; key: string; authed: boolean };

function registryOf(models: Model[]): LightModelRegistry<Model> {
  return {
    find: (provider, id) => models.find((item) => item.provider === provider && item.id === id),
    hasConfiguredAuth: (model) => model.authed,
  };
}

const cheap = { provider: "relay", id: "flash", key: "relay/flash", authed: true };
const heavy = { provider: "relay", id: "opus", key: "relay/opus", authed: true };
const pin = { provider: cheap.provider, id: cheap.id };

test("unset means no opinion: the conversation's own model answers", () => {
  const registry = registryOf([cheap, heavy]);
  assert.equal(lightModelFor(registry, undefined, heavy), heavy);
  assert.equal(pinnedLightModel(registry, undefined), undefined);
});

test("a usable pin outranks the conversation's model", () => {
  const registry = registryOf([cheap, heavy]);
  assert.equal(lightModelFor(registry, pin, heavy), cheap);
});

test("a pin whose provider has no key falls back rather than failing the job", () => {
  // The catalog holds every reseller's model, so `find` answers for an install that
  // cannot authenticate it — exactly the "No API key found" a role's `model:` line used
  // to cause. A title is not worth that error.
  const registry = registryOf([{ ...cheap, authed: false }, heavy]);
  assert.equal(lightModelFor(registry, pin, heavy), heavy);
});

test("a pin for a model the catalog no longer holds falls back too", () => {
  const registry = registryOf([heavy]);
  assert.equal(lightModelFor(registry, pin, heavy), heavy);
  assert.equal(pinnedLightModel(registry, pin), undefined);
});

test("a job with no conversation of its own gets the pin alone, or nothing", () => {
  const registry = registryOf([cheap, heavy]);
  assert.equal(lightModelFor(registry, pin, undefined), cheap);
  assert.equal(lightModelFor(registry, undefined, undefined), undefined);
});

test("no registry is not an error — the caller's model still answers", () => {
  assert.equal(lightModelFor(undefined, pin, heavy), heavy);
  assert.equal(pinnedLightModel(undefined, pin), undefined);
});

test("the setting is read from settings.json, and malformed values are ignored", () => {
  const dir = mkdtempSync(join(tmpdir(), "light-model-"));
  const paths = { settingsFile: join(dir, "settings.json") } as FastVibePaths;
  const write = (settings: Record<string, unknown>): void => {
    writeFileSync(paths.settingsFile, `${JSON.stringify({ version: 1, settings }, null, 2)}\n`);
    // The reader caches on the file's own mtime and size; two writes inside one
    // millisecond would otherwise be read as the same file.
    invalidateAppSettingsCache();
  };

  write({ lightModel: pin });
  assert.deepEqual(readLightModel(paths), pin);

  // Absent is the default, and it means "follow each chat's own model".
  write({});
  assert.equal(readLightModel(paths), undefined);

  // A half-written or foreign value must never reach the engine's model lookup.
  write({ lightModel: { provider: "relay" } });
  assert.equal(readLightModel(paths), undefined);
  write({ lightModel: "relay/flash" });
  assert.equal(readLightModel(paths), undefined);
  write({ lightModel: { provider: "", id: "flash" } });
  assert.equal(readLightModel(paths), undefined);

  // The pin beside 会话模型 must not be read as one, or the reverse.
  write({ defaultModel: heavy, lightModel: pin });
  assert.deepEqual(readLightModel(paths), pin);
});
