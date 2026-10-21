import {
  isRetryableAssistantError,
  retryDelayMs,
  type AssistantMessage,
  type RetryPolicy,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

/**
 * FastVibe's built-in session title — names a new conversation from the first
 * user prompt via a short, fire-and-forget model call (`pi.setSessionName`).
 *
 * Already-named sessions (manual rename, `/name`, parallel runs, side chats) are left
 * alone. The request runs on 轻量模型 (设置 → 模型) when the host reports a pin this install
 * can authenticate, else on the model the conversation is on. A transient failure is
 * retried under the engine's own retry policy; a session this never manages to title
 * keeps the truncated-prompt
 * fallback the host set. One shot per session is the budget: a later message
 * must not rename a chat the first one already spoke for.
 */
const MAX_TITLE = 24;
const SHORT_TITLE = 16;
const PROMPT_CHARS = 500;
const TITLE_TIMEOUT_MS = 20_000;

/** Mirrors `SETTINGS_DEFAULTS.retry` in the SDK, for an install that stored none. */
const DEFAULT_RETRY: RetryPolicy = { enabled: true, maxRetries: 3, baseDelayMs: 2000, maxAgentDelayMs: 60_000 };

/**
 * The host bridge FastVibe injects on `ctx.ui` (`FastVibeExtensionUIContext` in
 * `src/main/pi/process-manager.ts`). Optional because a host that is not FastVibe — the
 * pi CLI, a test harness — binds the SDK's own UI context and has no pin to hand out.
 */
type LightModelHost = {
  /** 轻量模型 (设置 → 模型): the model short side jobs run on, when the user pinned one. */
  lightModel?(): { provider: string; id: string } | undefined;
};

/**
 * Which model names this chat: the 轻量模型 the user pinned for side jobs, when this
 * install can still authenticate it, else the model the conversation is on — which is
 * what every title did before the pin existed. A pin whose provider was deleted, or whose
 * model was dropped by 同步模型, falls back rather than costing the chat its title.
 */
function titleModel(ctx: ExtensionContext): ExtensionContext["model"] {
  const pinned = (ctx.ui as unknown as LightModelHost).lightModel?.();
  if (pinned) {
    const model = ctx.modelRegistry.find(pinned.provider, pinned.id);
    if (model && ctx.modelRegistry.hasConfiguredAuth(model)) return model;
  }
  return ctx.model;
}

const INSTRUCTIONS = [
  "You name chat sessions. Reply with a title only.",
  "Rules:",
  `- at most ${SHORT_TITLE} characters (CJK counts as 1)`,
  "- no quotes, trailing punctuation, or emoji",
  "- same language as the user",
  "- no leading labels like Title: or 标题：",
  "- output the title alone: no preamble, no reasoning, no explanation",
].join("\n");

function hasUserMessages(ctx: ExtensionContext): boolean {
  return ctx.sessionManager.getBranch().some((entry) => entry.type === "message" && entry.message.role === "user");
}

/** A slash command with no arguments is not worth naming from. */
function isBareCommand(text: string): boolean {
  return /^\/\S+$/.test(text);
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max).trim();
}

/**
 * Normalize a model reply into a candidate title, without truncating it.
 * Whether it is short enough to be a title is decided by `candidateTitle`.
 */
function cleanTitle(raw: string): string {
  let text = raw.trim().split(/\r?\n/, 1)[0] ?? "";
  text = text.replace(/^["「『“']+|["」』”']+$/g, "").trim();
  text = text.replace(/^(title|标题)\s*[:：]\s*/i, "").trim();
  text = text.replace(/[\s.。!！?？,，;；:：]+$/g, "").trim();
  return text;
}

/** True when a text block is the model's running commentary rather than its answer. */
function isCommentary(signature: string | undefined): boolean {
  if (!signature) return false;
  try {
    return (JSON.parse(signature) as { phase?: unknown }).phase === "commentary";
  } catch {
    return false;
  }
}

/** The model's answer text, dropping commentary blocks when the provider tags them. */
function answerText(content: readonly { type: string; text?: string; textSignature?: string }[]): string {
  const text = content.filter(
    (block): block is { type: "text"; text: string; textSignature?: string } =>
      block.type === "text" && typeof block.text === "string",
  );
  const final = text.filter((block) => !isCommentary(block.textSignature));
  return (final.length > 0 ? final : text).map((block) => block.text).join("");
}

/**
 * The title a reply yields, or undefined when the reply is not usable as one.
 * A model that ignores the instruction and answers in prose produces a sentence,
 * and clipping that to MAX_TITLE yields garbage like "We need answer user's re" —
 * so an unusable answer is treated like a failed call and another attempt is made
 * for it. Only a naturally finished reply is considered: "length"/"aborted" means
 * the model was still rambling when it was cut off.
 */
function candidateTitle(response: AssistantMessage): string | undefined {
  if (response.stopReason !== "stop") return undefined;
  const title = cleanTitle(answerText(response.content));
  if (!title || title.length > MAX_TITLE) return undefined;
  return title;
}

/**
 * The engine's retry policy, read per call so a settings change lands without a
 * reload. `getSettings()` reports what is stored rather than defaults merged in,
 * so every field falls back to the SDK's own default.
 */
function retryPolicy(pi: ExtensionAPI): RetryPolicy {
  const stored = pi.getSettings()?.retry;
  return {
    enabled: stored?.enabled ?? DEFAULT_RETRY.enabled,
    maxRetries: Math.max(0, stored?.maxRetries ?? DEFAULT_RETRY.maxRetries),
    baseDelayMs: Math.max(0, stored?.baseDelayMs ?? DEFAULT_RETRY.baseDelayMs),
    maxAgentDelayMs: stored?.maxAgentDelayMs ?? DEFAULT_RETRY.maxAgentDelayMs,
  };
}

/** Whether a thrown failure looks like the transient kind worth another attempt. */
function isTransientThrow(error: unknown): boolean {
  const errorMessage = error instanceof Error ? error.message : String(error);
  // The classifier reads only `stopReason` and `errorMessage`, so a thrown error is
  // judged by the same provider/transport wording as a failed reply.
  return isRetryableAssistantError({ stopReason: "error", errorMessage } as AssistantMessage);
}

/** Wait out a retry backoff, ending at once when the run is stopped. */
async function backoff(ms: number, signal: AbortSignal | undefined): Promise<void> {
  if (ms <= 0 || signal?.aborted) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(finish, ms);
    function finish(): void {
      clearTimeout(timer);
      signal?.removeEventListener("abort", finish);
      resolve();
    }
    signal?.addEventListener("abort", finish, { once: true });
  });
}

/**
 * Fold `/skill:name …` back out of a prompt the engine has already expanded.
 *
 * By the time `before_agent_start` sees it, that command has become the whole `SKILL.md`
 * wrapped in a `<skill …>` block — 3 KB to 40 KB of instructions for the model, which must
 * not become the chat's name. This mirrors `src/shared/skill-invocation.ts`, which an
 * extension cannot import (it ships as a loose file); `test/skill-invocation.test.ts` keeps
 * the two spellings of the block in step.
 */
const SKILL_BLOCK = /^<skill name="([^"]+)" location="([^"]*)">\n([\s\S]*?)\n<\/skill>(?:\n\n([\s\S]+))?$/;

function foldSkill(text: string): string {
  const match = SKILL_BLOCK.exec(text);
  if (!match) return text;
  return match[4] ? `/skill:${match[1]} ${match[4]}` : `/skill:${match[1]}`;
}

function promptText(raw: string): string {
  const text = foldSkill(raw.trim());
  if (!text) return "";
  // A skill forced with nothing typed after it says nothing about what the chat is for.
  if (/^\/\S+$/.test(text)) return "";
  const withoutCommand = text.replace(/^\/\S+\s+/, "").trim();
  return clip(withoutCommand || text, PROMPT_CHARS);
}

export default function sessionTitle(pi: ExtensionAPI): void {
  let attempted = false;
  /**
   * The title request is not part of the run, so it carries no run signal of its own:
   * `ctx.signal` is still undefined when `before_agent_start` fires (the getter only
   * has one from `agent_start` onward). Stop therefore arrives through `agent_end`,
   * which reports the abort — a stopped chat must not keep paying for a title it will
   * not show, nor keep retrying one behind a backoff.
   */
  const controllers = new Set<AbortController>();

  const apply = (name: string): void => {
    const title = cleanTitle(name);
    if (!title || title.length > MAX_TITLE) return;
    // A rename that landed while we were generating wins.
    if (pi.getSessionName()) return;
    pi.setSessionName(title);
  };

  const generate = async (prompt: string, ctx: ExtensionContext): Promise<void> => {
    const controller = new AbortController();
    controllers.add(controller);
    // The call is fire-and-forget, so nothing may escape it: a chat closed or replaced
    // while the title was generating makes `ctx` stale, and its getters throw.
    try {
      const model = titleModel(ctx);
      if (!model || !ctx.modelRegistry.hasConfiguredAuth(model)) return;
      const policy = retryPolicy(pi);
      // The initial attempt plus the engine's retry budget — the same policy its own
      // summarisation calls follow, so one transient provider failure does not cost
      // this chat its title.
      const attempts = (policy.enabled ? policy.maxRetries : 0) + 1;
      const signal = controller.signal;
      for (let attempt = 1; attempt <= attempts; attempt += 1) {
        if (signal.aborted) return;
        let response: AssistantMessage;
        try {
          response = await ctx.modelRegistry.complete(
            model,
            {
              messages: [
                {
                  role: "user",
                  content: `${INSTRUCTIONS}\n\n<message>\n${prompt}\n</message>\n\nTitle:`,
                  timestamp: Date.now(),
                },
              ],
            },
            { maxTokens: 128, cacheRetention: "none", timeoutMs: TITLE_TIMEOUT_MS, signal },
          );
        } catch (error) {
          // A thrown failure is the runtime refusing outright (no provider, unreadable
          // auth) unless the SDK's own classifier calls its wording transient.
          if (!isTransientThrow(error) || attempt === attempts) return;
          await backoff(retryDelayMs(policy, attempt), signal);
          continue;
        }
        // A deterministic reply failure (quota, billing, a rejected key) fails the same
        // way however often it is sent; a transient one, and a reply that carried no
        // usable title, are what another attempt is for.
        if (response.stopReason === "aborted") return;
        if (response.stopReason === "error" && !isRetryableAssistantError(response)) return;
        const title = candidateTitle(response);
        if (title) {
          apply(title);
          return;
        }
        if (attempt === attempts) return;
        await backoff(retryDelayMs(policy, attempt), signal);
      }
    } catch {
      // Keep the host's truncated-prompt title.
    } finally {
      controllers.delete(controller);
    }
  };

  pi.on("session_start", (_event, ctx) => {
    attempted = Boolean(pi.getSessionName()) || hasUserMessages(ctx);
  });

  pi.on("agent_end", (event) => {
    const last = [...event.messages].reverse().find((message) => message.role === "assistant");
    if (last?.role !== "assistant" || last.stopReason !== "aborted") return;
    for (const controller of controllers) controller.abort();
    controllers.clear();
  });

  pi.on("session_shutdown", () => {
    for (const controller of controllers) controller.abort();
    controllers.clear();
  });

  pi.on("before_agent_start", (event, ctx) => {
    // 1.2.0 also fires this for an idle custom message (`triggerTurn`). Those have
    // no prompt, and a notice must not become the chat's title.
    if (event.messageType !== "user" || attempted || pi.getSessionName()) return;
    const prompt = promptText(event.prompt);
    if (!prompt || isBareCommand(event.prompt.trim())) return;
    attempted = true;
    // Short first messages already make a good title; skip the extra call.
    if (prompt.length <= SHORT_TITLE && !prompt.includes("\n")) {
      apply(prompt);
      return;
    }
    void generate(prompt, ctx);
  });
}
