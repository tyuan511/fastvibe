import assert from "node:assert/strict";
import test from "node:test";
import { testProviderModel, providerTestError } from "../src/main/engine/provider-test.ts";

const model = { id: "test", api: "openai-completions" };
const done = (content: unknown[]) => ({ type: "done", message: { content } });

test("checks streaming and a harmless tool schema without executing it", async () => {
  let calls = 0;
  const result = await testProviderModel(model as never, ((_, context, options) => {
    calls++;
    assert.equal(options.maxRetries, 0);
    assert.ok(options.signal);
    return (async function* () {
      if (calls === 1) { yield { type: "text_delta", delta: "OK" }; yield done([{ type: "text", text: "OK" }]); }
      else { assert.equal(context.tools?.[0].name, "fastvibe_probe"); yield done([{ type: "toolCall", name: "fastvibe_probe", arguments: { value: "ok" } }]); }
    })();
  }) as never);
  assert.equal(calls, 2);
  assert.equal(result.status, "passed");
  assert.equal(result.tools, "passed");
  assert.equal(typeof result.firstTokenMs, "number");
});

test("a plain reply to the tool request is unconfirmed, never reported as success", async () => {
  const result = await testProviderModel(model as never, (() => (async function* () { yield done([{ type: "text", text: "OK" }]); })()) as never);
  assert.equal(result.status, "partial");
  assert.equal(result.tools, "unconfirmed");
});

test("provider errors return a category without echoing credentials or response bodies", async () => {
  const result = await testProviderModel(model as never, (() => (async function* () { throw new Error("401 invalid API key secret-value"); })()) as never);
  assert.equal(result.errorCode, "auth");
  assert.equal(result.status, "failed");
  assert.ok(!JSON.stringify(result).includes("secret-value"));
  assert.equal(providerTestError(429, ""), "rate-limit");
  assert.equal(providerTestError(404, ""), "protocol");
  assert.equal(providerTestError(undefined, "ECONNRESET"), "network");
});
