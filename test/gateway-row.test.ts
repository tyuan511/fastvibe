import assert from "node:assert/strict";
import test from "node:test";
import { gatewayRowState } from "../src/renderer/src/lib/gateway-row.ts";

/** Minimal provider shape for the decision; only the fields it reads matter. */
function provider(over: Partial<Parameters<typeof gatewayRowState>[0]> = {}) {
  return {
    id: "p",
    kind: "custom",
    name: "P",
    baseUrl: "https://h/v1",
    api: "openai-completions",
    apiKeyEnv: "K",
    hasKey: true,
    hasOAuth: false,
    supportsKey: true,
    enabled: true,
    models: [],
    ...over,
  } as Parameters<typeof gatewayRowState>[0];
}

/**
 * The built-in FastVibe gateway is the one row that always works out of the box: it is a
 * Sub2API deployment, so its panel answers for this install's key with no probing and no
 * configuration. Gating the row on `kind === "custom"` removed exactly that row.
 */
test("the builtin FastVibe gateway shows its balance", () => {
  const state = gatewayRowState(provider({ id: "fastvibe", kind: "builtin", gateway: "sub2api" }));
  assert.equal(state.showValue, true);
  assert.equal(state.offerIdentify, false);
});

test("a builtin is never offered 识别, even with no gateway recorded", () => {
  const state = gatewayRowState(provider({ id: "fastvibe", kind: "builtin" }));
  assert.equal(state.offerIdentify, false);
  assert.equal(state.readable, false);
});

test("a custom endpoint nobody identified offers 识别 instead of nothing", () => {
  const state = gatewayRowState(provider({ gateway: undefined }));
  assert.equal(state.offerIdentify, true);
  assert.equal(state.showValue, false);
});

test("an identified new-api without a panel credential asks for one", () => {
  const state = gatewayRowState(provider({ gateway: "new-api" }));
  assert.equal(state.needsCredential, true);
  assert.equal(state.showValue, false, "no request is made without the credential");
  assert.equal(state.readable, true, "there is a balance, it just cannot be read yet");
});

test("a new-api with the credential stored reads normally", () => {
  const state = gatewayRowState(provider({ gateway: "new-api", gatewayCredential: true }));
  assert.equal(state.showValue, true);
  assert.equal(state.needsCredential, false);
});

test("a sub2api needs no panel credential, custom or builtin", () => {
  for (const kind of ["custom", "builtin"] as const) {
    const state = gatewayRowState(provider({ kind, gateway: "sub2api" }));
    assert.equal(state.showValue, true, kind);
  }
});

test("a provider with no credential shows nothing, because there is nothing to ask with", () => {
  const state = gatewayRowState(provider({ gateway: "sub2api", hasKey: false }));
  assert.equal(state.showValue, false);
  assert.equal(state.readable, false);
});

test("a native provider is never offered 识别 — its gateway comes from the SDK", () => {
  const state = gatewayRowState(provider({ kind: "native", baseUrl: "https://api.deepseek.com" }));
  assert.equal(state.offerIdentify, false);
  assert.equal(state.showValue, false);
});
