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
 * and the subagent runner from drifting apart. The env var is re-read per turn, so a
 * settings change reaches a running session.
 */
const PROMPT_ENV = "FASTVIBE_AI_LANGUAGE_PROMPT";

export default function outputLanguage(pi: ExtensionAPI): void {
  pi.on("before_agent_start", (event) => {
    const directive = process.env[PROMPT_ENV]?.trim();
    if (!directive) return;
    if (event.systemPrompt.includes(directive)) return;
    return { systemPrompt: `${event.systemPrompt}\n\n${directive}` };
  });
}
