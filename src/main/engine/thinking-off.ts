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
 *
 * The mirror-image failure is a model that has **no switch to turn thinking off at all**. When a
 * request asks for no thinking, pi fills an OpenAI-family `/responses` body with
 * `reasoning: { effort: "none" }` — right for gpt-5.1 onward, a 400 for the reasoning models
 * before it, which know only minimal/low/medium/high. FastVibe asks for no thinking on every short
 * side request (a chat's title, a handoff summary, a commit subject, 回复推荐, a memory extraction),
 * and it never maps `off` itself because its UI never offers that level, so the value reaching the
 * upstream is pi's guess and nothing else. The failure also lands outside the agent loop, where no
 * retry policy runs: a gpt-5 chat simply never got a title.
 *
 * pi's lever here is `thinkingLevelMap: { off: null }` — "this model has no off switch", so the
 * parameter is left out and the upstream answers with the model's own default. That is the same
 * answer `withAdaptiveOff` in `pi-global-sync.ts` gives a Claude model that only accepts adaptive
 * thinking. Here it is applied **after the upstream has said so**, not always: leaving the field
 * out means the model may think, and not thinking is what these requests are after.
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

/**
 * The APIs where pi fills in a thinking-off value for a request that asked for no thinking
 * at all: every `responses` family member, and chat completions only when the model maps
 * `off` to a value of its own. Measured against pi-ai's own providers (`off: null` removes it).
 */
const INVENTS_THINKING_OFF = ["openai-responses", "azure-openai-responses", "openai-codex-responses"];

export type ThinkingOffSwitchModel = {
  api?: string;
  provider?: string;
  id?: string;
  reasoning?: boolean;
  maxTokens?: number;
  thinkingLevelMap?: Record<string, string | null>;
};

/** Whether this model would be sent a thinking-off parameter nobody asked for. */
export function willSendThinkingOff(model: ThinkingOffSwitchModel): boolean {
  if (model.reasoning !== true || model.thinkingLevelMap?.off === null) return false;
  if (INVENTS_THINKING_OFF.includes(model.api ?? "")) return true;
  return model.api === "openai-completions" && typeof model.thinkingLevelMap?.off === "string";
}

/** The same model told to pi as having no off switch, so the parameter is left out. */
export function modelWithoutThinkingOff<M extends ThinkingOffSwitchModel>(model: M): M {
  if (model.thinkingLevelMap?.off === null) return model;
  return { ...model, thinkingLevelMap: { ...model.thinkingLevelMap, off: null } } as M;
}

/**
 * Whether a failure says the thinking-off parameter is what the upstream refused. OpenAI words
 * it as `Invalid value for 'reasoning.effort': 'none' is not supported by this model`; relays
 * answer with `"param": "reasoning.effort"` next to an `invalid_request_error`. A bare 400 is
 * not enough — a bad key, a missing model and an oversized request all answer with one, and
 * none of them is fixed by dropping this field.
 */
export function looksLikeRejectedThinkingOff(message: string | undefined): boolean {
  if (!message) return false;
  const refusedParameter =
    /(reasoning[\s_.]*effort|reasoning_effort|\beffort\b|\breasoning\b|\bthinking\b)/i.test(message) &&
    /(invalid|not supported|unsupported|unrecognized|unexpected|must be|supported values|one of)/i.test(message);
  // Some endpoints name only the rejected value: `Invalid value: 'none'. Supported values are:
  // 'minimal', 'low', and 'medium'.` The quotes are what keeps "none of the API keys are valid"
  // out of this branch.
  const refusedTheValue = /["'`]none["'`]/i.test(message) && /(invalid value|not supported|supported values are|unsupported)/i.test(message);
  return refusedParameter || refusedTheValue;
}

/** Output room for a request that can no longer be told not to think: thinking counts against the cap. */
export const THINKING_ROOM_TOKENS = 1024;

/**
 * The cap for a request made without the thinking-off parameter. A caller that asked for a
 * sentence-sized budget would otherwise be cut off mid-thought and answer with nothing, which is
 * how a retried title request would fail exactly like the one it replaced.
 */
export function roomForThinking(model: { maxTokens?: number }, asked: number | undefined): number {
  const room = Math.min(THINKING_ROOM_TOKENS, model.maxTokens || THINKING_ROOM_TOKENS);
  return Math.max(asked ?? 0, room);
}

/** What these helpers read off a side request: an output cap, a thinking level and a cancel handle. */
type SideRequest = { maxTokens?: number; signal?: AbortSignal; reasoning?: unknown };
/** The same request as the runtime sees it: the guard adds a payload hook to ask for no thinking. */
type CompleteRequest = SideRequest & { onPayload?: (payload: unknown, model: unknown) => unknown };
/** A reply as these helpers need to see it. */
type SideReply = { stopReason?: string; errorMessage?: string };

/**
 * Whether to add the switches that ask for no thinking.
 *
 * Only a request that names **no thinking level** gets them. That is what every side request in the
 * app is (a chat's title, `/handoff`, a commit subject, a memory extraction), while the agent's own
 * turn names the reader's level and 「跟随模型默认」 means leave the parameter alone — a main chat
 * must not be quietly de-thoughted by a guard written for the bypath calls.
 *
 * A reasoning model this app cannot tell not to think is the one that needs them: FastVibe never
 * maps `off`, so on a `chat/completions` endpoint pi sends nothing at all and the model thinks at
 * its own default. Measured on a Qwen token-plan endpoint, an unpatched commit subject given 512
 * output tokens came back `length` with no text after 10.5s, while the same model on 回复推荐's
 * patched path answered in 0.6–1.8s.
 */
export function shouldAskWithoutThinking(model: ThinkingOffSwitchModel, options: SideRequest | undefined): boolean {
  return model.reasoning === true && options?.reasoning === undefined && canTurnThinkingOff(model);
}

/**
 * The same request with room for a thought it could not prevent. `maxTokens` is only a ceiling, so
 * raising it costs nothing on a model that obeys the switch, and on one that does not it is the
 * difference between an answer and a truncated empty one.
 */
export function withThinkingRoom<M extends ThinkingOffSwitchModel>(model: M, options: SideRequest | undefined): SideRequest | undefined {
  if (model.reasoning !== true || options?.reasoning !== undefined) return options;
  return { ...(options ?? {}), maxTokens: roomForThinking(model, options?.maxTokens) };
}

/**
 * Run a side request, and run it again without the invented thinking-off parameter if the upstream
 * refuses that parameter — once per model, remembered in `refused` so no later request pays for the
 * same refusal. Any other failure is handed back exactly as it came (a reply with `stopReason:
 * "error"`, or the thrown error), because a timeout or a bad key is not fixed by dropping a field
 * and the caller's own retry logic is the one that should see it.
 */
export async function retryWithoutThinkingOff<M extends ThinkingOffSwitchModel, T extends SideReply>(
  run: (model: M, options: SideRequest | undefined) => Promise<T>,
  input: { model: M; options?: SideRequest; refused: Set<string>; aborted?: () => boolean; onRefused?: (failure: string) => void },
): Promise<T> {
  const { model, options } = input;
  const key = `${model.provider ?? ""}/${model.id ?? ""}`;
  if (!willSendThinkingOff(model)) return run(model, options);
  const withoutSwitch = () =>
    run(modelWithoutThinkingOff(model), options?.maxTokens === undefined ? options : { ...options, maxTokens: roomForThinking(model, options.maxTokens) });
  // A model this app has already been refused goes straight out without the field: the caller
  // hands over the registry's own model every time, so the learning has to live here.
  if (input.refused.has(key)) return withoutSwitch();
  let failure: string | undefined;
  let thrown: unknown;
  let reply: T | undefined;
  try {
    reply = await run(model, options);
    if (reply?.stopReason !== "error") return reply;
    failure = reply.errorMessage;
  } catch (error) {
    thrown = error;
    failure = error instanceof Error ? error.message : String(error);
  }
  if (input.aborted?.() || !looksLikeRejectedThinkingOff(failure)) {
    if (thrown !== undefined) throw thrown;
    return reply as T;
  }
  input.refused.add(key);
  input.onRefused?.(failure ?? "");
  return withoutSwitch();
}

/** The model to send now: the guarded copy once this model has been refused, else its own. */
export function guardedModelFor<M extends ThinkingOffSwitchModel>(model: M, refused: Set<string>): M {
  const key = `${model.provider ?? ""}/${model.id ?? ""}`;
  return refused.has(key) && willSendThinkingOff(model) ? modelWithoutThinkingOff(model) : model;
}

/**
 * Teach a model runtime that a model whose endpoint refused pi's invented thinking-off parameter
 * should never be sent it again. Both seams are wrapped, because that is where every request in the
 * app is made:
 *
 * - `complete` — the side requests without a thinking level (a chat's title and `/handoff` through
 *   the extensions' own `ctx.modelRegistry`, a commit subject, a memory extraction). These are
 *   promises, so a refusal is caught here: ask again with the field left out, and remember the model.
 *   This is also where the request is told not to think directly (`shouldAskWithoutThinking`) rather
 *   than at each call site: a 128-token title and a 512-token subject fail identically on a model
 *   that thinks first, and a call site that forgets the patch fails *silently* — the chat just keeps
 *   its fallback title, the git pane just says generation did not finish.
 * - `streamSimple` — passively, no retry: a model already known to have no off switch is handed to
 *   the real method already guarded. It is wrapped because the **agent's own** requests go through
 *   it (`pi-coding-agent`'s `streamFn` closure calls `modelRuntime.streamSimple`, see
 *   `core/sdk.js:270`, and compaction and branch summaries reuse that same function), so a session
 *   whose thinking level is ever `off` would meet the identical 400 in the middle of a chat. A
 *   stream cannot be retried here without restarting it mid-flight, and the level case is rare
 *   enough that applying what was already learned is the right bargain.
 *
 * Both are instance properties on the runtime FastVibe created, so the SDK's own facades — it builds
 * a second `ModelRegistry` over this runtime for extensions — reach them too. The runtime's own
 * signatures are generic over the api; the guard only reads and copies the thinking map, so it is
 * written against that narrower shape and casts at the seam.
 */
export function installThinkingOffGuard(runtime: object, refused: Set<string>, fieldsRefused: Set<string> = new Set()): void {
  // The runtime's own reply always names how it ended, which is what `withThinkingOffFallback`
  // reads to decide whether the endpoint refused the fields.
  type Complete = (model: ThinkingOffSwitchModel, context: unknown, options?: CompleteRequest) => Promise<{ stopReason: string; errorMessage?: string }>;
  type StreamSimple = (model: ThinkingOffSwitchModel, context: unknown, options?: SideRequest) => unknown;
  const target = runtime as unknown as { complete: Complete; streamSimple: StreamSimple };
  const original: Complete = target.complete.bind(target);
  const originalStreamSimple: StreamSimple = target.streamSimple.bind(target);
  target.complete = (model, context, options) =>
    retryWithoutThinkingOff(
      (guardedModel, requestOptions) => {
        // Two refusals, each tried once and remembered per model, because an endpoint can take one
        // of these switches and refuse the other: the fields added here, and the value pi invents.
        const prepared = withThinkingRoom(guardedModel, requestOptions ?? options);
        const key = `${guardedModel.provider ?? ""}/${guardedModel.id ?? ""}`;
        return withThinkingOffFallback(
          (patched) => original(guardedModel, context, patched ? { ...prepared, onPayload: (payload: unknown) => withThinkingOff(payload) } : prepared),
          {
            eligible: shouldAskWithoutThinking(guardedModel, options),
            key,
            refused: fieldsRefused,
            aborted: () => options?.signal?.aborted === true,
            onRefused: (failure) => console.info(`[thinking-off] ${key} refused the thinking-off fields (${failure.slice(0, 120)}); asking again without them`),
          },
        );
      },
      {
        model,
        options,
        refused,
        aborted: () => options?.signal?.aborted === true,
        onRefused: (failure) => console.info(`[thinking-off] ${model.provider}/${model.id} refused the thinking-off parameter (${failure.slice(0, 120)}); asking again without it`),
      },
    );
  target.streamSimple = (model, context, options) => originalStreamSimple(guardedModelFor(model, refused), context, options);
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
