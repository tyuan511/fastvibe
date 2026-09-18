import { test } from "node:test";
import assert from "node:assert/strict";
import { engineModelBaseUrl, trimBaseUrl } from "../src/main/engine/provider-url.ts";

/**
 * One provider holds **one** `baseUrl`, but the four clients address their endpoint from it
 * very differently — the OpenAI ones append below the version prefix, the Anthropic one
 * appends `/v1/messages` itself, and pi's Google client leaves the version to the base
 * entirely while Google's is `v1beta`, not `v1`. `engineModelBaseUrl` is the only place
 * that reconciles them, and getting it wrong is silent in the worst way: a relay carrying
 * several protocols answers some models and 404s others, with nothing on screen to say why.
 * So all three shapes are pinned here, at the URL level, not as a diff of strings.
 */

const OPENAI_APIS = ["openai-completions", "openai-responses"];

test("an OpenAI base is taken exactly as typed", () => {
  for (const api of OPENAI_APIS) {
    assert.equal(engineModelBaseUrl("https://relay.example.com/v1", api), "https://relay.example.com/v1");
    assert.equal(engineModelBaseUrl("https://relay.example.com", api), "https://relay.example.com");
    // A relay that mounts the OpenAI api under its own path is not ours to reinterpret.
    assert.equal(engineModelBaseUrl("https://api.z.ai/api/coding/paas/v4", api), "https://api.z.ai/api/coding/paas/v4");
  }
});

test("a Messages base loses the version segment the Anthropic client adds itself", () => {
  // The client posts to `{base}/v1/messages`, so a base carrying a segment reaches
  // `/v1/v1/messages` — the 404 this rule exists for.
  assert.equal(engineModelBaseUrl("https://relay.example.com/v1", "anthropic-messages"), "https://relay.example.com");
  assert.equal(engineModelBaseUrl("https://relay.example.com/v1beta", "anthropic-messages"), "https://relay.example.com");
  assert.equal(engineModelBaseUrl("https://relay.example.com/v1/", "anthropic-messages"), "https://relay.example.com");
  // …but everything in front of the segment stays: relays front Messages beside an
  // OpenAI-compatible `/v1` all the time.
  assert.equal(engineModelBaseUrl("https://relay.example.com/anthropic/v1", "anthropic-messages"), "https://relay.example.com/anthropic");
  // A bare host is already what the client wants (Anthropic's own base, minimax's).
  assert.equal(engineModelBaseUrl("https://api.anthropic.com", "anthropic-messages"), "https://api.anthropic.com");
  assert.equal(engineModelBaseUrl("https://api.minimaxi.com/anthropic", "anthropic-messages"), "https://api.minimaxi.com/anthropic");
  // Only the version segments FastVibe itself hands a user are recognised: z.ai's `/v4`
  // is part of the endpoint path, and stripping it would break the provider.
  assert.equal(engineModelBaseUrl("https://api.z.ai/api/coding/paas/v4", "anthropic-messages"), "https://api.z.ai/api/coding/paas/v4");
});

test("a Gemini base carries v1beta, because pi's Google client adds no version at all", () => {
  // `apiVersion: ""` in pi's google client: `{base}/models/{id}:streamGenerateContent`, so
  // the OpenAI-style `/v1` a shared base is written with sends it to a 404.
  assert.equal(engineModelBaseUrl("https://relay.example.com/v1", "google-generative-ai"), "https://relay.example.com/v1beta");
  assert.equal(engineModelBaseUrl("https://relay.example.com/v1/", "google-generative-ai"), "https://relay.example.com/v1beta");
  // Already right, whether it came from the placeholder or from Google itself.
  assert.equal(engineModelBaseUrl("https://relay.example.com/v1beta", "google-generative-ai"), "https://relay.example.com/v1beta");
  assert.equal(engineModelBaseUrl("https://generativelanguage.googleapis.com/v1beta", "google-generative-ai"), "https://generativelanguage.googleapis.com/v1beta");
  // Nothing to translate.
  assert.equal(engineModelBaseUrl("https://relay.example.com", "google-generative-ai"), "https://relay.example.com");
});

test("trailing slashes never survive, whatever the api", () => {
  // `https://host/v1/` + `/responses` would otherwise be `https://host/v1//responses`.
  for (const api of [...OPENAI_APIS, "anthropic-messages", "google-generative-ai"]) {
    assert.equal(trimBaseUrl("https://relay.example.com/v1///"), "https://relay.example.com/v1");
    assert.ok(!engineModelBaseUrl("https://relay.example.com/v1//", api).endsWith("/"));
  }
});
