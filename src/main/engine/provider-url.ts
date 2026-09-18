/**
 * Where one model's requests actually go.
 *
 * FastVibe stores **one** `baseUrl` per provider, and each protocol's client addresses its
 * endpoint from that base differently, so a base written for one protocol is wrong for
 * another. Three facts here, each measured against the SDK rather than assumed:
 *
 * - The OpenAI clients append `/chat/completions` / `/responses` *below* the version
 *   prefix, so `https://host/v1` is what they want, and the base is taken as typed.
 * - The Anthropic Messages client appends `/v1/messages` **itself**. A base that already
 *   carries a version segment therefore doubles it — `/v1/v1/messages`,
 *   `/v1beta/v1/messages` — and the model is simply unreachable.
 * - pi's Google client does the opposite of both: it sets `apiVersion: ""` and leaves the
 *   version to the base, so its base must carry one, and Google's native version is
 *   `v1beta`, not `v1`.
 *
 * Nothing exposes the mismatch while a provider serves one protocol — the user types
 * whichever base its protocol wants. It appears the moment one relay is configured with
 * several, which is exactly what a per-model `api` exists to allow: a Responses model
 * beside a Messages and a Gemini one, under a shared `https://host/v1` where only the
 * OpenAI ones can answer. So the segment is translated to the one the model's own client
 * needs, and `renderModelsJson` writes the result as that model's `baseUrl` — pi reads a
 * model-level `baseUrl` in preference to the provider's — while the provider keeps the base
 * the user typed for every other model.
 *
 * Only the two segments FastVibe itself hands a user are rewritten, and only on a base that
 * carries one. A relay fronting its protocols elsewhere (`https://host/anthropic`, z.ai's
 * `.../coding/paas/v4`) keeps what was entered and appends its path to it as always. An
 * OpenAI api is never rewritten either way: that base is what those clients use today, and
 * there is no way to prove the one the user typed is wrong.
 */

/** Trailing slashes trimmed — the one normalization a stored `baseUrl` needs before use. */
export function trimBaseUrl(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, "");
}

/**
 * The version segments a stored base can carry: OpenAI's `v1` (添加供应商's placeholder for
 * every api but Gemini) and Google's `v1beta`. Anything else is a path the relay owns —
 * z.ai's `.../coding/paas/v4` is an endpoint path whose segment merely looks like a
 * version — and is never rewritten.
 */
const VERSION_SEGMENT = /\/(v1|v1beta)$/;

export function engineModelBaseUrl(providerBaseUrl: string, api: string): string {
  const base = trimBaseUrl(providerBaseUrl);
  if (api === "anthropic-messages") return base.replace(VERSION_SEGMENT, "");
  if (api === "google-generative-ai") return base.replace(/\/v1$/, "/v1beta");
  return base;
}
