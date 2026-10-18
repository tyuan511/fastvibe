import type { ProviderApi } from "@shared/types";

/**
 * Which model-id prefixes name a native API, and which protocol that is.
 *
 * A provider's roster is read over one protocol, but a gateway commonly fronts several:
 * a `claude-*` id usually answers at `/v1/messages` and a `gemini-*` one at Google's
 * native `/v1beta/models/…:generateContent`, even when the base the user typed is the
 * OpenAI-shaped `/v1`. The prefix is the only signal the roster carries, so it decides
 * the per-model override, and `engineModelBaseUrl` then rewrites that model's base to
 * the shape its own client needs.
 *
 * Both are guesses, and each is one select away in 模型详情 › 协议 — which is the escape
 * hatch for a relay that forwards the model behind its OpenAI endpoint instead.
 *
 * One asymmetry to know about: `authHeader` is a *provider* field in pi's schema, so a
 * Gemini model pinned under an OpenAI-shaped provider still receives
 * `Authorization: Bearer …` next to the Google client's own `x-goog-api-key`. That is the
 * useful direction — a native-protocol relay commonly accepts only the bearer, which is
 * why `fetchGeminiModels` sends both — and Google's real endpoint is never in this
 * position, because a base that lists models natively is configured as a Google provider
 * and its models inherit the protocol instead of being overridden here.
 */
const NATIVE_API_BY_PREFIX: ReadonlyArray<readonly [RegExp, ProviderApi]> = [
  [/^claude-/i, "anthropic-messages"],
  [/^gemini-/i, "google-generative-ai"],
];

/**
 * Pick a per-model protocol override for models whose ids identify a native API.
 * The override is omitted when the provider already uses that protocol, so the
 * stored model can keep inheriting the provider default.
 */
export function automaticModelApi(id: string, providerApi?: string): ProviderApi | undefined {
  const trimmed = id.trim();
  for (const [pattern, api] of NATIVE_API_BY_PREFIX) {
    if (pattern.test(trimmed)) return providerApi === api ? undefined : api;
  }
  return undefined;
}
