import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * AI 偏好语言 (设置 → 通用 → 语言).
 *
 * On every turn — `before_agent_start` fires once per user prompt, before the agent
 * loop — this appends the host's language requirement to the system prompt. A system
 * prompt is rebuilt for every run, so nothing accumulates and a language changed
 * mid-conversation takes effect on the very next message.
 *
 * The sentence itself is not written here: Main owns the wording and hands it over in
 * `FASTVIBE_AI_LANGUAGE_PROMPT` (see `src/main/engine/ai-language.ts`), which keeps
 * this extension — a standalone jiti module that cannot import FastVibe internals —
 * and the subagent runner from drifting apart. The env vars are re-read per turn, so
 * a settings change reaches a running session without rebuilding it. The user's
 * personalization text is appended after the language directive.
 */
const PROMPT_ENV = "FASTVIBE_AI_LANGUAGE_PROMPT";
const CUSTOM_PROMPT_ENV = "FASTVIBE_CUSTOM_SYSTEM_PROMPT";

export default function outputLanguage(pi: ExtensionAPI): void {
  pi.on("before_agent_start", (event) => {
    const additions = [process.env[PROMPT_ENV], process.env[CUSTOM_PROMPT_ENV]]
      .map((value) => value?.trim())
      .filter((value): value is string => Boolean(value));
    let systemPrompt = event.systemPrompt;
    let changed = false;
    for (const addition of additions) {
      if (systemPrompt.includes(addition)) continue;
      systemPrompt = `${systemPrompt}\n\n${addition}`;
      changed = true;
    }
    return changed ? { systemPrompt } : undefined;
  });
}
