import assert from "node:assert/strict";
import test from "node:test";
import { piProviderModelsEntry } from "../src/main/engine/pi-global-sync.ts";

/**
 * A Claude model behind a custom Anthropic-compatible gateway is an unknown id to pi-ai,
 * so it streams with budgeted thinking unless models.json says otherwise — and Opus 5.5
 * answers that with a 400 ("requires adaptive thinking"). The answer comes from pi-ai's own
 * catalog, so these ids only need to exist there.
 */

function entry(id: string, reasoning = true) {
  const result = piProviderModelsEntry({
    id: "gw",
    kind: "custom",
    name: "GW",
    baseUrl: "https://gw.test",
    api: "anthropic-messages",
    models: [{ id, name: id, contextWindow: 200000, maxTokens: 8192, reasoning, input: ["text"] }],
  } as never) as { models: Array<{ compat?: Record<string, unknown>; thinkingLevelMap?: Record<string, unknown> }> };
  return result.models[0];
}

for (const id of ["claude-opus-5-5", "claude-sonnet-5-5", "anthropic/claude-fable-5-1", "claude-opus-4-8", "claude-sonnet-4-6", "claude-haiku-5-5", "claude-opus-5-5-20261001"]) {
  test(`${id} is forced to adaptive thinking`, () => {
    const model = entry(id);
    assert.equal(model.compat?.forceAdaptiveThinking, true);
    assert.equal(model.thinkingLevelMap?.off, null);
  });
}

for (const id of ["claude-opus-4-5", "claude-sonnet-4-5-20250929", "claude-opus-4-20250514", "claude-haiku-4-5", "claude-3-5-sonnet"]) {
  test(`${id} keeps budgeted thinking`, () => {
    const model = entry(id);
    assert.equal(model.compat, undefined);
    assert.equal(model.thinkingLevelMap, undefined);
  });
}

test("a gateway model borrows only the request-shape pins, not the first-party betas", () => {
  const model = entry("claude-opus-5-5");
  assert.deepEqual(model.compat, { forceAdaptiveThinking: true, supportsTemperature: false });
});

test("an id pi-ai does not list gets nothing", () => {
  assert.equal(entry("claude-opus-9-9").compat, undefined);
});

test("a non-reasoning model is left alone", () => {
  assert.equal(entry("claude-opus-5-5", false).thinkingLevelMap, undefined);
});
