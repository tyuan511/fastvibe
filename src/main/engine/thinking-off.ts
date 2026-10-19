/**
 * Best-effort 「don't think」 for short side requests (回复推荐).
 *
 * A reasoning model thinks by default, and thinking is nearly all of a short request's latency:
 * measured on a Qwen and a DeepSeek relay, the same suggestion took 2–8s with thinking and
 * 0.8–1.7s without. The SDK already sends the right switch when it recognises the provider's
 * `thinkingFormat`, but a custom relay's format is guessed from its URL and an unrecognised one
 * gets nothing — so the model thinks, and the app has no setting to say otherwise.
 *
 * So for OpenAI-compatible endpoints — chat completions, and Responses, because a relay serving a
 * model over /responses forwards the same switches to the backend (measured: the DeepSeek model
 * on the FastVibe relay is a /responses model, and stopped thinking with them) — the request also
 * carries them all. They are fields a strict endpoint may refuse (an unknown parameter is a 400),
 * which is why this is a *patch that can be taken back*: the caller retries once without it when
 * the failure reads like a rejected parameter, and remembers the model so the next request does
 * not pay for the same refusal.
 *
 * - `enable_thinking: false`                 Qwen's own switch (DashScope, vLLM's qwen parsers).
 * - `chat_template_kwargs.enable_thinking`   chat-template backends: vLLM, SGLang, most relays.
 * - `thinking: { type: "disabled" }`         DeepSeek and Z.ai.
 *
 * Anthropic and Google are left alone: with no reasoning level requested the SDK sends no thinking
 * for them, which already is "off". OpenAI's own Responses endpoint will refuse these fields and
 * take the retry path once.
 */

export type ThinkingOffTarget = { api?: string; reasoning?: boolean };

/** Whether this model has a thinking-off patch to try. */
export function canTurnThinkingOff(model: ThinkingOffTarget): boolean {
  return model.reasoning === true && (model.api === "openai-completions" || model.api === "openai-responses");
}

/**
 * The payload with the switches added. A field the SDK already set is the SDK's decision and is
 * left as it is; `chat_template_kwargs` is merged rather than replaced.
 */
export function withThinkingOff(payload: unknown): unknown {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return payload;
  const body = payload as Record<string, unknown>;
  const kwargs = typeof body.chat_template_kwargs === "object" && body.chat_template_kwargs !== null ? (body.chat_template_kwargs as Record<string, unknown>) : {};
  return {
    ...body,
    ...(body.enable_thinking === undefined ? { enable_thinking: false } : {}),
    ...(body.thinking === undefined ? { thinking: { type: "disabled" } } : {}),
    chat_template_kwargs: { ...(kwargs.enable_thinking === undefined ? { enable_thinking: false } : {}), ...kwargs },
  };
}

/**
 * A failure that reads like the endpoint refusing a parameter, as opposed to a timeout, a rate
 * limit or a bad key — only the first is fixed by taking the patch off, so only it is retried.
 */
export function looksLikeRejectedParameter(message: string | undefined): boolean {
  if (!message) return false;
  return /\b(400|422)\b|unknown (parameter|field|argument)|unrecognized|unsupported (parameter|field)|unexpected (field|keyword)|extra (inputs|fields)|not permitted|invalid (parameter|request)/i.test(message);
}

type Reply = { stopReason: string; errorMessage?: string };

/**
 * Run a request with the thinking-off patch, and without it if the endpoint refuses the patch.
 * `run(true)` is the patched attempt, `run(false)` the plain one. A model that refused is
 * remembered in `refused` and goes straight to the plain request from then on. Any other failure
 * — a timeout, a rate limit, a bad key — is the caller's to see, not a reason to ask twice.
 */
export async function withThinkingOffFallback<T extends Reply>(
  run: (patched: boolean) => Promise<T>,
  options: { eligible: boolean; key: string; refused: Set<string>; aborted: () => boolean; onRefused?: (failure: string) => void },
): Promise<T> {
  if (!options.eligible || options.refused.has(options.key)) return run(false);
  let failure: string | undefined;
  try {
    const reply = await run(true);
    if (reply.stopReason !== "error") return reply;
    failure = reply.errorMessage;
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
  }
  if (options.aborted() || !looksLikeRejectedParameter(failure)) throw new Error(failure || "request failed");
  options.refused.add(options.key);
  options.onRefused?.(failure ?? "");
  return run(false);
}

/** Output room for a model that never thinks first: the answer is a sentence. */
export const SUGGESTION_TOKENS = 80;
/** Output room for a model that may think first: thinking counts against the cap. */
export const SUGGESTION_TOKENS_WITH_THINKING = 1024;

/**
 * How many output tokens a suggestion request may use. `maxTokens` is only a ceiling — a short
 * answer costs the same under 80 as under 1024 — so a small one buys nothing but the risk of
 * cutting a reply off. It is small only where thinking cannot happen: a model that does not
 * reason, or Anthropic with no level asked for. Everywhere else the model may think first
 * (measured: 100–350 tokens), and **whether it does is not ours to decide**: the thinking-off
 * fields work reliably on Qwen but on the FastVibe relay's DeepSeek the same request thought in
 * one probe and not in the next, patched or not. An 80 cap there ended replies empty and the retry
 * doubled the wait (8s), so those models get the room.
 */
export function suggestionMaxTokens(model: ThinkingOffTarget & { maxTokens?: number }): number {
  const quiet = model.reasoning !== true || model.api === "anthropic-messages";
  const wanted = quiet ? SUGGESTION_TOKENS : SUGGESTION_TOKENS_WITH_THINKING;
  return Math.min(wanted, model.maxTokens || wanted);
}
