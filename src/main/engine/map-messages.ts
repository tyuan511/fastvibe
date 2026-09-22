import type { ChatAttachment, ChatMessage, MessagePart, ThinkingTiming, ToolCallBlock, TuiRun } from "@shared/types";
import { extractPromptAttachments } from "@shared/attachment-metadata";
import { toolResultStatus } from "@shared/tool-result";
import { uiText } from "./ui-text";

/**
 * Ceiling on the tool output that crosses into the renderer.
 *
 * Nothing capped it before: a `read` of a large file, or a command that printed a
 * build log, was structured-cloned over IPC in full and then held in the transcript
 * store for the life of the conversation — while the card that shows it clips at
 * 4000 characters. The headroom here is deliberate and generous, so a real diff or a
 * long test run still arrives whole; it is only the pathological case that is cut.
 * The engine's own copy is untouched: the model still sees the full result.
 */
const MAX_TOOL_RESULT_CHARS = 256_000;

export function capToolResult(text: string): string {
  if (text.length <= MAX_TOOL_RESULT_CHARS) return text;
  const dropped = text.length - MAX_TOOL_RESULT_CHARS;
  return `${text.slice(0, MAX_TOOL_RESULT_CHARS)}\n${uiText(
    `… 已截断 ${dropped} 个字符`,
    `… truncated ${dropped} characters`,
  )}`;
}

/**
 * `idOf` resolves the stable session-tree entry id for a raw engine message. The
 * engine's plain message objects carry no id, so without it every mapping minted a
 * fresh random id and the renderer could never branch (edit/retry) back into the
 * session tree.
 *
 * `timings` carries the thinking bounds Main timed while the reply streamed, keyed
 * by that same entry id; the transcript itself has no per-block timing, so without
 * it a reloaded block could only say 「思考」 with no duration.
 *
 * `completedAtOf` is the instant each message's session entry was persisted — the end
 * of the reply, since the engine stamps a message with its *request* start and only
 * appends the entry once streaming is over. Keyed by the same entry id.
 */
export function mapEngineMessages(
  raw: unknown,
  idOf?: (message: unknown) => string | undefined,
  timings?: ReadonlyMap<string, ThinkingTiming[]>,
  customRuns?: (message: Record<string, unknown>) => TuiRun[][] | undefined,
  completedAtOf?: ReadonlyMap<string, number>,
): ChatMessage[] {
  if (!Array.isArray(raw)) return [];
  const output: ChatMessage[] = [];
  for (const entry of raw) {
    const message = unwrapMessage(entry);
    if (!message) continue;
    // Extension custom messages carry a `customType` and a plugin renderer. Hidden
    // ones (`display: false`) are context injections and never belong in the thread.
    if (message.role === "custom") {
      if (message.display === false) continue;
      const customType = typeof message.customType === "string" ? message.customType : undefined;
      const { text, parts } = extractContent(message.content);
      output.push({
        id: idOf?.(entry) ?? String(message.id ?? crypto.randomUUID()),
        role: "system",
        text,
        tools: [],
        parts,
        createdAt: typeof message.timestamp === "number" ? message.timestamp : Date.now(),
        kind: "custom",
        customType,
        runs: customRuns?.(message),
      });
      continue;
    }
    if (message.role === "compactionSummary") {
      const summary = typeof message.summary === "string" ? message.summary : "";
      const tokensBefore = typeof message.tokensBefore === "number" ? message.tokensBefore : undefined;
      const createdAt = typeof message.timestamp === "number" ? message.timestamp : Date.now();
      output.push({
        id: idOf?.(entry) ?? `compact:${createdAt}`,
        role: "system",
        text: summary,
        tools: [],
        parts: summary ? [{ kind: "text", text: summary }] : [],
        createdAt,
        kind: "compact",
        compact: { status: "done", tokensBefore },
      });
      continue;
    }
    if (message.role === "toolResult") {
      const id = String(message.toolCallId ?? "");
      const result = toolText(message.content ?? message.result ?? message.output);
      if (id) {
        const assistant = [...output].reverse().find((item) => item.role === "assistant" && item.tools.some((tool) => tool.id === id));
        const tool = assistant?.tools.find((item) => item.id === id);
        if (tool) {
          if (result) tool.result = result;
          if (message.details !== undefined) tool.details = message.details;
          tool.status = toolResultStatus(tool.name, message.isError === true, message.details);
        }
      }
      continue;
    }
    const role = message.role === "assistant" || message.role === "system" ? message.role : "user";
    const { text, thinking, tools, attachments, parts } = extractContent(message.content);
    if (role === "user") attachments.push(...extractPromptAttachments(text));
    const id = idOf?.(entry) ?? String(message.id ?? crypto.randomUUID());
    applyThinkingTimings(parts, id ? timings?.get(id) : undefined);
    const error = assistantError(message);
    if (!text && !thinking && tools.length === 0 && attachments.length === 0 && !error && role !== "assistant") continue;
    output.push({
        id,
        role,
        text,
        thinking,
        tools,
        parts,
        createdAt: typeof message.timestamp === "number" ? message.timestamp : Date.now(),
        // Only a reply has an end distinct from its start; a user row's entry is
        // written at send time, so its timestamp already is the whole story.
        completedAt: role === "assistant" ? (id ? completedAtOf?.get(id) : undefined) : undefined,
        kind: role === "system" ? "notice" : "message",
        attachments: attachments.length > 0 ? attachments : undefined,
        error,
      });
  }
  return output;
}

/** Hand each measured block to the thinking part it belongs to, in content order. */
function applyThinkingTimings(parts: MessagePart[], timings: ThinkingTiming[] | undefined): void {
  if (!timings || timings.length === 0) return;
  let index = 0;
  for (const part of parts) {
    if (part.kind !== "thinking") continue;
    const timing = timings[index];
    index += 1;
    if (!timing) continue;
    part.startedAt = timing.startedAt;
    if (timing.endedAt !== undefined) part.endedAt = timing.endedAt;
  }
}

/** Surface a failed model request as an error on the assistant turn.
 *  User aborts (`stopReason: "aborted"`) stay silent — they already stopped on purpose. */
function assistantError(message: Record<string, unknown>): string | undefined {
  if (message.role !== "assistant" || message.stopReason !== "error") return undefined;
  const text = typeof message.errorMessage === "string" ? message.errorMessage.trim() : "";
  return text || "请求失败";
}

function unwrapMessage(entry: unknown): Record<string, unknown> | null {
  if (!isRecord(entry)) return null;
  if (isRecord(entry.message)) return { ...entry.message, id: entry.id ?? entry.message.id, _messageId: entry.message.id, timestamp: entry.timestamp };
  if (typeof entry.role === "string") return entry;
  return null;
}

function extractContent(content: unknown): {
  text: string;
  thinking?: string;
  tools: ToolCallBlock[];
  attachments: ChatAttachment[];
  parts: MessagePart[];
} {
  if (typeof content === "string") {
    return { text: content, tools: [], attachments: [], parts: content ? [{ kind: "text", text: content }] : [] };
  }
  if (!Array.isArray(content)) return { text: "", tools: [], attachments: [], parts: [] };
  const texts: string[] = [];
  const thoughts: string[] = [];
  const tools: ToolCallBlock[] = [];
  const attachments: ChatAttachment[] = [];
  const parts: MessagePart[] = [];
  const results = new Map<string, string>();
  /** Position of the next image in this message, which is what names it. */
  let images = 0;

  for (const part of content) {
    if (typeof part === "string") {
      texts.push(part);
      if (part) parts.push({ kind: "text", text: part });
      continue;
    }
    if (!isRecord(part)) continue;
    const type = String(part.type ?? "");
    if (type === "thinking") {
      const thought = typeof part.thinking === "string" ? part.thinking : typeof part.text === "string" ? part.text : "";
      if (thought) {
        thoughts.push(thought);
        parts.push({ kind: "thinking", text: thought });
      }
      continue;
    }
    if (typeof part.text === "string") {
      texts.push(part.text);
      if (part.text) parts.push({ kind: "text", text: part.text });
    }
    if (type === "tool_use" || type === "toolcall" || type === "tool_call" || type === "toolCall") {
      const id = String(part.id ?? crypto.randomUUID());
      tools.push({
        id,
        name: String(part.name ?? "tool"),
        args: part.arguments ?? part.input ?? part.args,
        status: "done",
      });
      parts.push({ kind: "tool", toolId: id });
    }
    if (type === "image" && typeof part.data === "string") {
      const mime = typeof part.mimeType === "string" ? part.mimeType : "image/png";
      attachments.push({
        // Positional, not random: this mapping runs again at the end of every turn,
        // and a fresh id made the message structurally different from the one already
        // on screen — so `reconcileMessages` could never reuse a row that carries an
        // image, and that row re-rendered (re-decoding its base64) at every turn end.
        // Ids only have to be unique within their own message; they are React keys
        // for one attachment strip.
        id: `image:${images}`,
        kind: "image",
        name: "image",
        mimeType: mime,
        dataUrl: `data:${mime};base64,${part.data}`,
      });
      images += 1;
    }
    if (type === "tool_result") {
      const id = String(part.tool_use_id ?? part.toolCallId ?? part.id ?? "");
      const text = toolText(part.content ?? part.output ?? part.result);
      if (id && text) results.set(id, text);
    }
  }

  for (const tool of tools) {
    const result = results.get(tool.id);
    if (result) tool.result = result;
  }

  return {
    text: texts.join("\n"),
    thinking: thoughts.length > 0 ? thoughts.join("\n") : undefined,
    tools,
    attachments,
    parts,
  };
}

function toolText(value: unknown): string | undefined {
  const text = rawToolText(value);
  return text === undefined ? undefined : capToolResult(text);
}

function rawToolText(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value
      .map((part) => {
        if (typeof part === "string") return part;
        if (isRecord(part) && typeof part.text === "string") return part.text;
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  if (isRecord(value) && typeof value.text === "string") return value.text;
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
