import { test } from "node:test";
import assert from "node:assert/strict";
import { automaticModelApi } from "../src/main/engine/model-api.ts";

test("claude-* models use the Anthropic Messages protocol", () => {
  assert.equal(automaticModelApi("claude-sonnet-4-5", "openai-responses"), "anthropic-messages");
  assert.equal(automaticModelApi("claude-3-7-sonnet", "openai-completions"), "anthropic-messages");
  assert.equal(automaticModelApi("CLAUDE-OPUS-4-1", "openai-responses"), "anthropic-messages");
});

test("the automatic protocol does not create redundant or unrelated overrides", () => {
  assert.equal(automaticModelApi("claude-sonnet-4-5", "anthropic-messages"), undefined);
  assert.equal(automaticModelApi("gemini-2.5-pro", "openai-responses"), undefined);
  assert.equal(automaticModelApi("anthropic/claude-sonnet-4-5", "openai-responses"), undefined);
});
