import type { SessionEntry } from "@earendil-works/pi-coding-agent";

/**
 * What stage 1 reads of a finished conversation, and what it is not allowed to keep.
 *
 * Only the conversation's words and the shape of its tool use go in: thinking blocks,
 * hidden custom messages and system prompts are not memory-relevant, and a tool result is
 * clipped hard because the long ones (a file, a build log) are the least reusable part.
 */

/** One row's cap (Codex's `MAX_ROW_BYTES`), and the tighter one for tool output (`TOOL_OUTPUT_TOKENS`, 2,000 tokens). */
const MAX_TEXT_CHARS = 10_000;
const MAX_TOOL_ARGS_CHARS = 10_000;
const MAX_TOOL_RESULT_CHARS = 8_000;
/** What one extraction may read when the model's window is unknown: Codex's fallback of 150k tokens. */
export const MAX_ROLLOUT_CHARS = 450_000;
/** Below this a conversation has said nothing worth distilling. */
export const MIN_ROLLOUT_CHARS = 200;

export type RenderedRollout = {
  text: string;
  userMessages: number;
  assistantMessages: number;
  /** True when the middle was cut to fit. */
  truncated: boolean;
};

/** Credentials a conversation may contain; each match is replaced, never partially kept. */
const REDACTED = "[REDACTED_SECRET]";
const SECRET_PATTERNS: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  /\bsk-[A-Za-z0-9_-]{16,}/g,
  /\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{20,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\bAIza[0-9A-Za-z_-]{30,}/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{16,}/gi,
];

/** `key = value` assignments whose key names a secret; the key stays so the memory still says what existed. */
const SECRET_ASSIGNMENT = /\b([A-Za-z0-9_.-]*(?:api[_-]?key|secret|token|passwd|password|credential)[A-Za-z0-9_.-]*)(\s*["']?\s*[:=]\s*["']?)([^\s"',;]{6,})/gi;

export function redactSecrets(text: string): string {
  let out = text;
  for (const pattern of SECRET_PATTERNS) out = out.replace(pattern, (_match, scheme: unknown) => typeof scheme === "string" ? `${scheme} ${REDACTED}` : REDACTED);
  return out.replace(SECRET_ASSIGNMENT, (_match, key: string, separator: string) => `${key}${separator}${REDACTED}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function clip(text: string, limit: number): string {
  const flat = text.trim();
  return flat.length > limit ? `${flat.slice(0, limit)}…` : flat;
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => (isRecord(block) && block.type === "text" && typeof block.text === "string" ? block.text : ""))
    .filter(Boolean)
    .join("\n");
}

function toolCallsOf(content: unknown): string[] {
  if (!Array.isArray(content)) return [];
  const lines: string[] = [];
  for (const block of content) {
    if (!isRecord(block) || block.type !== "toolCall" || typeof block.name !== "string") continue;
    let args = "";
    try { args = JSON.stringify(block.arguments ?? {}); } catch { /* an unserialisable argument bag is just omitted */ }
    lines.push(`[tool call] ${block.name} ${clip(args, MAX_TOOL_ARGS_CHARS)}`.trimEnd());
  }
  return lines;
}

/** One branch of a conversation as plain text, secrets already removed. */
export function renderRollout(branch: readonly SessionEntry[], maxChars = MAX_ROLLOUT_CHARS): RenderedRollout {
  const lines: string[] = [];
  let userMessages = 0;
  let assistantMessages = 0;
  for (const entry of branch) {
    if (entry.type !== "message") continue;
    const message = entry.message as unknown;
    if (!isRecord(message)) continue;
    const role = message.role;
    if (role === "user") {
      const text = textOf(message.content);
      if (!text.trim()) continue;
      userMessages += 1;
      lines.push(`[user] ${clip(text, MAX_TEXT_CHARS)}`);
    } else if (role === "assistant") {
      const text = textOf(message.content);
      if (text.trim()) {
        assistantMessages += 1;
        lines.push(`[assistant] ${clip(text, MAX_TEXT_CHARS)}`);
      }
      lines.push(...toolCallsOf(message.content));
    } else if (role === "toolResult") {
      const text = textOf(message.content);
      if (!text.trim()) continue;
      const name = typeof message.toolName === "string" ? message.toolName : "tool";
      lines.push(`[tool result: ${name}] ${clip(text, MAX_TOOL_RESULT_CHARS)}`);
    }
  }
  let text = redactSecrets(lines.join("\n"));
  let truncated = false;
  if (text.length > maxChars) {
    truncated = true;
    const marker = "\n[... response items omitted ...]\n";
    const head = Math.floor((maxChars - marker.length) / 2);
    const tail = maxChars - marker.length - head;
    text = `${text.slice(0, head)}${marker}${text.slice(text.length - tail)}`;
  }
  return { text, userMessages, assistantMessages, truncated };
}

/** Worth sending to the model at all: someone asked something and the agent answered. */
export function hasSubstance(rendered: RenderedRollout): boolean {
  return rendered.userMessages > 0 && rendered.assistantMessages > 0 && rendered.text.length >= MIN_ROLLOUT_CHARS;
}
