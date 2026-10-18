import { test } from "node:test";
import assert from "node:assert/strict";
import { automaticModelApi } from "../src/main/engine/model-api.ts";

test("claude-* models use the Anthropic Messages protocol", () => {
  assert.equal(automaticModelApi("claude-sonnet-4-5", "openai-responses"), "anthropic-messages");
  assert.equal(automaticModelApi("claude-3-7-sonnet", "openai-completions"), "anthropic-messages");
  assert.equal(automaticModelApi("CLAUDE-OPUS-4-1", "openai-responses"), "anthropic-messages");
});

test("gemini-* models use Google's native protocol", () => {
  assert.equal(automaticModelApi("gemini-2.5-pro", "openai-responses"), "google-generative-ai");
  assert.equal(automaticModelApi("gemini-3.7-flash", "openai-completions"), "google-generative-ai");
  assert.equal(automaticModelApi(" GEMINI-3-1-PRO ", "anthropic-messages"), "google-generative-ai");
});

test("the automatic protocol does not create redundant or unrelated overrides", () => {
  // The provider already speaks it, so the model keeps inheriting — no pinned chip.
  assert.equal(automaticModelApi("claude-sonnet-4-5", "anthropic-messages"), undefined);
  assert.equal(automaticModelApi("gemini-2.5-pro", "google-generative-ai"), undefined);
  // Namespaced ids are not the model's own name: `models/` and `anthropic/` are stripped
  // before a roster is built, so a bare prefix match here would be a different model.
  assert.equal(automaticModelApi("anthropic/claude-sonnet-4-5", "openai-responses"), undefined);
  assert.equal(automaticModelApi("models/gemini-2.5-pro", "openai-responses"), undefined);
  assert.equal(automaticModelApi("deepseek-v3", "openai-completions"), undefined);
  assert.equal(automaticModelApi("grok-4-7", "openai-responses"), undefined);
});
