import type {
  ChatAttachment,
  ChatMessage,
  CompactInfo,
  CompactReason,
  EngineEvent,
  EngineModel,
  MessagePart,
  ToolCallBlock,
} from "@shared/types";
import { i18n } from "@/lib/i18n";

export type ApplyResult = {
  messages: ChatMessage[];
  streaming: boolean;
  /**
   * Set on `agent_end` when the run stopped early: a failure (`error`) or a user
   * abort (`aborted`). The caller keeps the follow-up queue paused and offers to
   * resume the turn instead of draining the queue onto a half-finished
   * conversation.
   */
  interrupted?: "aborted" | "error";
  /**
   * Part index a model switch recorded *now* belongs at: the end of everything the
   * engine has settled so far, which is where the next assistant message's content
   * begins. Returned on every event where an engine message starts or ends, so the
   * caller can keep it across streamed deltas — while the parts of the message in
   * flight grow, the boundary must not move. `model_changed` is emitted from the
   * assistant `message_start` the new model is about to run, so the boundary at that
   * moment is exactly where the divider belongs: the top of that reply.
   */
  partBoundary?: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** Does the transcript already hold an optimistic user row awaiting its session id? */
export function lastUserIsLocal(messages: ChatMessage[]): boolean {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].role !== "user") continue;
    return messages[index].id.startsWith("local:");
  }
  return false;
}

/** Text of a user `message_start` the engine just injected, if any. */
export function userMessageText(event: EngineEvent): string | undefined {
  if (event.type !== "message_start") return undefined;
  const message = isRecord(event.message) ? event.message : undefined;
  if (!message || message.role !== "user") return undefined;
  return contentText(message.content);
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (typeof part === "string") return part;
      if (isRecord(part) && typeof part.text === "string") return part.text;
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function userRowFromEngine(message: Record<string, unknown>): ChatMessage {
  const text = contentText(message.content);
  const attachments: ChatAttachment[] = [];
  if (Array.isArray(message.content)) {
    for (const part of message.content) {
      if (!isRecord(part) || part.type !== "image" || typeof part.data !== "string") continue;
      const mimeType = typeof part.mimeType === "string" ? part.mimeType : "image/png";
      attachments.push({
        id: crypto.randomUUID(),
        kind: "image",
        name: "image",
        mimeType,
        dataUrl: `data:${mimeType};base64,${part.data}`,
      });
    }
  }
  return {
    id: `local:${crypto.randomUUID()}`,
    role: "user",
    text,
    tools: [],
    parts: text ? [{ kind: "text", text }] : [],
    createdAt: typeof message.timestamp === "number" ? message.timestamp : Date.now(),
    attachments: attachments.length > 0 ? attachments : undefined,
  };
}

function asEngineModel(value: unknown): EngineModel | undefined {
  if (!isRecord(value)) return undefined;
  const provider = asString(value.provider);
  const id = asString(value.id);
  return provider && id ? { provider, id } : undefined;
}

/** Parts already in the trailing assistant — the reply being streamed into, if any. */
function trailingParts(messages: ChatMessage[]): number {
  const last = messages.at(-1);
  return last?.role === "assistant" ? (last.parts?.length ?? 0) : 0;
}

/**
 * Events after which everything the engine has produced so far is settled, so a
 * switch recorded at that moment belongs at the end of it — the next engine message
 * has either just finished or is about to start. Deliberately excludes the events
 * that append content (deltas, tool-call starts): those must not move the boundary,
 * since the divider lands *before* the content of the message in flight.
 */
const MESSAGE_BOUNDARY_EVENTS = new Set([
  "agent_start",
  "agent_settled",
  "turn_start",
  "message_start",
  "message_end",
  "turn_end",
  "agent_end",
  "tool_execution_start",
  "tool_execution_end",
]);

/** User aborts stay silent; only `stopReason: "error"` becomes a visible failure. */
function errorFromAssistant(value: unknown): string | undefined {
  if (!isRecord(value) || value.stopReason !== "error") return undefined;
  const text = typeof value.errorMessage === "string" ? value.errorMessage.trim() : "";
  return text || (i18n.t("common:errors.requestFailed") as string);
}

/**
 * Same ceiling Main applies to a transcript read (`capToolResult`), enforced again
 * here because a live result reaches the store through the event stream rather than
 * through that path. Without it a single `read` of a large file sat in the
 * transcript for the life of the conversation to fill a card that clips at 4000
 * characters.
 */
const MAX_TOOL_RESULT_CHARS = 256_000;

function capToolResult(text: string): string {
  if (text.length <= MAX_TOOL_RESULT_CHARS) return text;
  const dropped = text.length - MAX_TOOL_RESULT_CHARS;
  return `${text.slice(0, MAX_TOOL_RESULT_CHARS)}\n${i18n.t("common:notice.resultTruncated", { count: dropped })}`;
}

function toolText(value: unknown): string | undefined {
  const text = rawToolText(value);
  return text === undefined ? undefined : capToolResult(text);
}

function rawToolText(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (!isRecord(value)) {
    try {
      return JSON.stringify(value);
    } catch {
      return undefined;
    }
  }
  if (typeof value.content === "string") return value.content;
  if (Array.isArray(value.content)) {
    return value.content
      .map((part) => {
        if (typeof part === "string") return part;
        if (isRecord(part) && typeof part.text === "string") return part.text;
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  if (typeof value.text === "string") return value.text;
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}

/** The engine wraps tool results as `{ content, details }`; keep `details` for rich renderers. */
function toolDetails(value: unknown): unknown {
  return isRecord(value) ? value.details : undefined;
}

/** Only the trailing assistant belongs to the current turn. Searching backwards
 *  would merge a new reply into the previous assistant after the user sent. */
function trailingAssistant(messages: ChatMessage[]): ChatMessage | undefined {
  const last = messages.at(-1);
  return last?.role === "assistant" ? last : undefined;
}

/**
 * Copy-on-write view of the trailing assistant. Unchanged rows keep their object
 * identity so React can skip re-rendering them; only the assistant (and its
 * tools) that is actually being streamed into gets cloned. Cloning every message
 * on every token made long sessions progressively slower.
 *
 * The two arrays are copied, but their *elements* are not: `upsertTool` and
 * `appendDelta` already replace the single entry they touch with a fresh object,
 * so cloning every entry here only destroyed the identity `ToolCard` /
 * `ToolGroupRow` / `ThinkingBlock` are memoised on — a reply with twenty tool
 * calls re-rendered all twenty cards on every flush, each one re-scanning its
 * whole result for a diff, to show one new token of text.
 */
function withAssistant(messages: ChatMessage[]): { list: ChatMessage[]; assistant: ChatMessage } {
  const last = messages.at(-1);
  if (last?.role === "assistant") {
    const assistant: ChatMessage = {
      ...last,
      tools: last.tools.slice(),
      parts: last.parts ? last.parts.slice() : [],
    };
    const list = messages.slice();
    list[list.length - 1] = assistant;
    return { list, assistant };
  }
  const assistant: ChatMessage = {
    id: crypto.randomUUID(),
    role: "assistant",
    text: "",
    tools: [],
    parts: [],
    createdAt: Date.now(),
  };
  return { list: [...messages, assistant], assistant };
}

function appendMessage(messages: ChatMessage[], message: ChatMessage): ChatMessage[] {
  return [...messages, message];
}

/** Drop a superseded failure off every consecutive trailing assistant.
 *  `ensureAssistant` only clones `at(-1)`, so a transcript that still holds the
 *  429 attempt behind the retry (or a model switch) would otherwise keep the
 *  stale error on an earlier row. */
function clearTrailingAssistantErrors(messages: ChatMessage[]): ChatMessage[] {
  let next = messages;
  for (let index = next.length - 1; index >= 0; index -= 1) {
    const item = next[index];
    if (item.role !== "assistant") break;
    if (!item.error) continue;
    if (next === messages) next = next.slice();
    next[index] = { ...item, error: undefined };
  }
  return next;
}

const COMPACT_REASONS = new Set<CompactReason>(["manual", "threshold", "overflow"]);

function compactReason(event: EngineEvent): CompactReason | undefined {
  const reason = asString(event.reason);
  return reason && COMPACT_REASONS.has(reason as CompactReason) ? (reason as CompactReason) : undefined;
}

function compactFromEnd(event: EngineEvent): { compact: CompactInfo; summary: string } {
  const result = isRecord(event.result) ? event.result : undefined;
  const error = asString(event.errorMessage);
  const status: CompactInfo["status"] =
    event.aborted === true ? "aborted" : error ? "error" : "done";
  return {
    compact: {
      status,
      reason: compactReason(event),
      tokensBefore: typeof result?.tokensBefore === "number" ? result.tokensBefore : undefined,
      tokensAfter: typeof result?.estimatedTokensAfter === "number" ? result.estimatedTokensAfter : undefined,
      error: status === "error" ? error : undefined,
    },
    summary: status === "done" ? (asString(result?.summary) ?? "") : "",
  };
}

function compactMessage(compact: CompactInfo, summary = ""): ChatMessage {
  const text = compact.status === "error" ? (compact.error ?? "") : summary;
  return {
    id: crypto.randomUUID(),
    role: "system",
    text,
    tools: [],
    parts: text ? [{ kind: "text", text }] : [],
    createdAt: Date.now(),
    kind: "compact",
    compact,
  };
}

/**
 * Append a streamed text/thinking delta to the ordered parts. Consecutive deltas of
 * the same kind extend the trailing part, so the renderer can interleave prose and
 * tool calls in the exact order the engine produced them.
 */
function appendDelta(message: ChatMessage, kind: "text" | "thinking", delta: string): void {
  if (!delta) return;
  const parts = (message.parts ??= []);
  const last = parts.at(-1);
  if (last?.kind === kind) {
    const text = `${last.text}${delta}`;
    // `{...last}` keeps a thinking part's measured bounds; Main re-sends them on
    // every delta, but the part must not depend on that to stay timed.
    parts[parts.length - 1] = kind === "text" ? { kind: "text", text } : { ...last, text };
    return;
  }
  parts.push(kind === "text" ? { kind: "text", text: delta } : { kind: "thinking", text: delta });
}

/** Record a tool call's position in the message, once. Idempotent across retried events. */
function pushToolPart(message: ChatMessage, toolId: string): void {
  const parts = (message.parts ??= []);
  if (parts.some((part) => part.kind === "tool" && part.toolId === toolId)) return;
  parts.push({ kind: "tool", toolId });
}

/**
 * Mirror the bounds Main measured for the block being streamed onto the thinking
 * part currently being written. The part is the trailing one only while its deltas
 * are arriving, so a text/tool delta that follows simply finds nothing to stamp.
 */
function stampThinkingTiming(message: ChatMessage, event: Record<string, unknown>): void {
  const startedAt = typeof event.thinkingStartedAt === "number" ? event.thinkingStartedAt : undefined;
  const endedAt = typeof event.thinkingEndedAt === "number" ? event.thinkingEndedAt : undefined;
  if (startedAt === undefined && endedAt === undefined) return;
  const parts = message.parts;
  const part = parts?.at(-1);
  if (!parts || !part || part.kind !== "thinking") return;
  // Main re-sends the bounds on every delta, so most calls have nothing to say.
  // Bail before writing: the part is shared with the previous snapshot (see
  // `withAssistant`), and replacing it unconditionally would both mutate history
  // and hand `ThinkingBlock` a new identity on every flush.
  const changed =
    (startedAt !== undefined && part.startedAt !== startedAt) ||
    (endedAt !== undefined && part.endedAt !== endedAt);
  if (!changed) return;
  parts[parts.length - 1] = {
    ...part,
    startedAt: startedAt ?? part.startedAt,
    endedAt: endedAt ?? part.endedAt,
  };
}

function upsertTool(message: ChatMessage, patch: Partial<ToolCallBlock> & { id: string }): void {
  const index = message.tools.findIndex((tool) => tool.id === patch.id);
  if (index === -1) {
    message.tools.push({
      id: patch.id,
      name: patch.name ?? "tool",
      args: patch.args,
      result: patch.result,
      status: patch.status ?? "running",
      details: patch.details,
    });
    pushToolPart(message, patch.id);
    return;
  }
  // Never let an absent field erase what a richer earlier event already provided.
  const current = message.tools[index];
  const next: ToolCallBlock = { ...current };
  if (patch.name !== undefined) next.name = patch.name;
  if (patch.args !== undefined) next.args = patch.args;
  if (patch.result !== undefined) next.result = patch.result;
  if (patch.status !== undefined) next.status = patch.status;
  if (patch.details !== undefined) next.details = patch.details;
  message.tools[index] = next;
}

/**
 * `toolcall_start` identifies the call only by `contentIndex` into
 * `partial.content`; the tool name/args live on that block. Resolving it here is
 * what stops every card from rendering as the literal label "tool".
 */
function toolCallFromPartial(inner: Record<string, unknown>): Record<string, unknown> | undefined {
  const partial = inner.partial;
  if (!isRecord(partial) || !Array.isArray(partial.content)) return undefined;
  const index = typeof inner.contentIndex === "number" ? inner.contentIndex : undefined;
  const block = index === undefined ? partial.content.at(-1) : partial.content[index];
  return isRecord(block) ? block : undefined;
}

/** Adopt the id an earlier event already created when the engine omits it. */
function resolveToolId(message: ChatMessage, candidate: string | undefined): string {
  if (candidate && message.tools.some((tool) => tool.id === candidate)) return candidate;
  const stale = [...message.tools].reverse().find((tool) => tool.status === "running" && !tool.name);
  if (stale) return stale.id;
  return candidate ?? crypto.randomUUID();
}

export function applyEngineEvent(
  messages: ChatMessage[],
  event: EngineEvent,
  streaming: boolean,
  boundary = 0,
): ApplyResult {
  const result = applyEvent(messages, event, streaming, boundary);
  if (!MESSAGE_BOUNDARY_EVENTS.has(String(event.type))) return result;
  return { ...result, partBoundary: trailingParts(result.messages) };
}

function applyEvent(
  messages: ChatMessage[],
  event: EngineEvent,
  streaming: boolean,
  boundary: number,
): ApplyResult {
  let next = messages;
  let nextStreaming = streaming;
  const type = event.type;

  // The engine persisted the optimistic user turn and handed back its session
  // entry id. Adopt it so the row can branch (retry / edit) later; the message
  // itself is unchanged. Optimistic turns are minted with a `local:` id.
  if (type === "user_message_persisted") {
    const entryId = asString(event.entryId);
    if (entryId) {
      for (let index = next.length - 1; index >= 0; index -= 1) {
        if (next[index].role !== "user" || !next[index].id.startsWith("local:")) continue;
        const list = next.slice();
        list[index] = { ...next[index], id: entryId };
        next = list;
        break;
      }
    }
    return { messages: next, streaming: nextStreaming };
  }

  // A user turn the engine injected itself — a steer delivered between turns.
  // The composer's own prompt is already on screen as a `local:` row, so that
  // echo is skipped; `user_message_persisted` adopts its session id.
  if (type === "message_start") {
    const message = isRecord(event.message) ? event.message : undefined;
    if (message?.role !== "user") return { messages: next, streaming: nextStreaming };
    if (lastUserIsLocal(next)) return { messages: next, streaming: nextStreaming };
    return { messages: appendMessage(next, userRowFromEngine(message)), streaming: nextStreaming };
  }

  // Lazily materialise the trailing assistant only for events that write to it.
  let assistant: ChatMessage | undefined;
  const ensureAssistant = (): ChatMessage => {
    if (assistant) return assistant;
    const created = withAssistant(next);
    next = created.list;
    assistant = created.assistant;
    return assistant;
  };

  if (type === "agent_start" || type === "turn_start") {
    // A new turn replaces a previous failure (including auto-retry). Keep the
    // bubble, but drop the stale error so the working state can take over.
    ensureAssistant();
    return { messages: clearTrailingAssistantErrors(next), streaming: true };
  }

  if (type === "message_end") {
    const error = errorFromAssistant(event.message);
    if (error) {
      const last = next.at(-1);
      if (last?.role === "assistant") {
        const list = next.slice();
        list[list.length - 1] = { ...last, error };
        return { messages: list, streaming: nextStreaming };
      }
    }
    return { messages: next, streaming: nextStreaming };
  }

  if (type === "turn_end") {
    // A turn ending is not a run ending. `turn_end` fires after every assistant
    // message — including each one that only requested a tool call — and the agent
    // immediately feeds the tool results back into another turn. Clearing the
    // working state here made the footer, caret and "working" row blink once per
    // tool call. Only `agent_end` closes the run.
    const error = errorFromAssistant(event.message);
    if (error) {
      const last = next.at(-1);
      if (last?.role === "assistant") {
        const list = next.slice();
        list[list.length - 1] = { ...last, error };
        return { messages: list, streaming: nextStreaming };
      }
    }
    return { messages: next, streaming: nextStreaming };
  }

  if (type === "agent_end") {
    const lastEngine = Array.isArray(event.messages) ? event.messages.at(-1) : undefined;
    const error = errorFromAssistant(lastEngine);
    // A run that failed or was aborted stopped before the model finished; a clean
    // turn ends with `stopReason` `stop`/`toolUse`/`length`. When the engine is about
    // to auto-retry (`willRetry`), this is a transient failure the SDK is already
    // recovering from, so it is not a terminal interruption.
    const stopReason = isRecord(lastEngine) ? asString(lastEngine.stopReason) : undefined;
    const interrupted: ApplyResult["interrupted"] =
      event.willRetry === true ? undefined : error ? "error" : stopReason === "aborted" ? "aborted" : undefined;
    if (error) {
      const last = next.at(-1);
      if (last?.role === "assistant") {
        const list = next.slice();
        list[list.length - 1] = { ...last, error: last.error ?? error };
        return { messages: list, streaming: nextStreaming, interrupted };
      }
      return {
        messages: appendMessage(next, {
          id: crypto.randomUUID(),
          role: "assistant",
          text: "",
          tools: [],
          parts: [],
          createdAt: Date.now(),
          error,
        }),
        streaming: nextStreaming,
        interrupted,
      };
    }
    // Deliberately still working: `agent_end` is not the end of the run. The SDK
    // fires it before it retries (`willRetry`), compacts, or continues with messages
    // an `agent_end` handler queued — and only `agent_settled` says that whole
    // post-run sequence is finished. Clearing the run here made the caret, the
    // working row and the sidebar go idle for the length of a retry backoff.
    return { messages: next, streaming: nextStreaming, interrupted };
  }

  if (type === "agent_settled") {
    // The run (retries, auto-compaction and continuations included) has finished.
    return { messages: next, streaming: false };
  }

  if (type === "prompt_result") {
    if (event.agentInvoked === false) {
      return { messages: next, streaming: false };
    }
    return { messages: next, streaming: nextStreaming };
  }

  if (type === "model_changed") {
    // Main emits this from the assistant `message_start` the new model is about to
    // run — picking a model is not using one, so a switch that no reply ever followed
    // is never announced. The boundary at that instant is the end of everything
    // settled, so the divider opens the reply the new model is about to write; a
    // switch made mid-run lands between the run's parts, the same slot the transcript
    // puts it in when it is re-read.
    const to = asEngineModel(event.model);
    if (!to) return { messages: next, streaming: nextStreaming };
    const from = asEngineModel(event.previous);
    // Nothing on screen to annotate: a switch made before the conversation has any
    // content would otherwise open the thread with a divider.
    if (next.length === 0) return { messages: next, streaming: nextStreaming };
    const target = ensureAssistant();
    const parts: MessagePart[] = (target.parts ??= []);
    parts.splice(Math.max(0, Math.min(boundary, parts.length)), 0, { kind: "model", from, to });
    return { messages: next, streaming: nextStreaming };
  }

  if (type === "notice") {
    const text = asString(event.message) ?? asString(event.title) ?? toolText(event) ?? "notice";
    return {
      messages: appendMessage(next, {
        id: crypto.randomUUID(),
        role: "system",
        text,
        tools: [],
        parts: [{ kind: "text", text }],
        createdAt: Date.now(),
      }),
      streaming: nextStreaming,
    };
  }

  if (type === "command_output") {
    const text = asString(event.output) ?? asString(event.text) ?? toolText(event.data);
    if (text) {
      const target = ensureAssistant();
      target.text = target.text ? `${target.text}\n${text}` : text;
      appendDelta(target, "text", `${target.parts?.length ? "\n" : ""}${text}`);
    }
    return { messages: next, streaming: nextStreaming };
  }

  if (type === "compaction_start" || type === "auto_compaction_start") {
    // A compaction that was already in flight when this conversation was (re)loaded
    // is already on screen — the engine re-serves its running card — so a retry
    // updates that card's reason instead of stacking a second one on top of it.
    const last = next.at(-1);
    if (last?.kind === "compact" && last.compact?.status === "running") {
      return { messages: next, streaming: nextStreaming };
    }
    return {
      messages: appendMessage(next, compactMessage({ status: "running", reason: compactReason(event) })),
      streaming: nextStreaming,
    };
  }

  if (type === "compaction_end" || type === "auto_compaction_end") {
    const { compact, summary } = compactFromEnd(event);
    const last = next.at(-1);
    if (last?.kind === "compact") {
      const text = compact.status === "error" ? (compact.error ?? "") : summary;
      const list = next.slice();
      list[list.length - 1] = {
        ...last,
        text,
        parts: text ? [{ kind: "text", text }] : [],
        compact,
      };
      return { messages: list, streaming: nextStreaming };
    }
    return { messages: appendMessage(next, compactMessage(compact, summary)), streaming: nextStreaming };
  }

  if (type === "todo_reminder" || type === "todo_auto_clear") {
    const text =
      asString(event.message) ??
      asString(event.reminder) ??
      (type === "todo_auto_clear"
        ? (i18n.t("common:notice.todoCleared") as string)
        : (i18n.t("common:notice.todoReminder") as string));
    return {
      messages: appendMessage(next, {
        id: crypto.randomUUID(),
        role: "system",
        text,
        tools: [],
        parts: [{ kind: "text", text }],
        createdAt: Date.now(),
        kind: "notice",
      }),
      streaming: nextStreaming,
    };
  }

  if (type === "message_update") {
    const inner = isRecord(event.assistantMessageEvent) ? event.assistantMessageEvent : null;
    const innerType = asString(inner?.type);
    if (!inner) return { messages: next, streaming: nextStreaming };

    if (innerType === "text_delta") {
      const delta = asString(inner.delta) ?? asString(inner.text) ?? "";
      if (delta) {
        const target = ensureAssistant();
        target.text += delta;
        appendDelta(target, "text", delta);
        nextStreaming = true;
      }
    }
    if (innerType === "thinking_delta") {
      const delta = asString(inner.delta) ?? asString(inner.text) ?? "";
      if (delta) {
        const target = ensureAssistant();
        target.thinking = `${target.thinking ?? ""}${delta}`;
        appendDelta(target, "thinking", delta);
        nextStreaming = true;
      }
    }
    if (innerType === "toolcall_start" || innerType === "tool_call_start") {
      const target = ensureAssistant();
      const block = toolCallFromPartial(inner);
      upsertTool(target, {
        id: asString(block?.id) ?? asString(inner.id) ?? crypto.randomUUID(),
        name: asString(block?.name) ?? asString(inner.name) ?? "",
        args: block?.arguments ?? inner.arguments ?? inner.args ?? inner.input,
        status: "running",
      });
      nextStreaming = true;
    }
    if (innerType === "toolcall_delta" || innerType === "tool_call_delta") {
      // The delta is partial argument JSON, not output; take the parsed args back
      // off the partial message so the card can show the command as it forms.
      const target = ensureAssistant();
      const block = toolCallFromPartial(inner);
      const id = resolveToolId(target, asString(block?.id) ?? asString(inner.id));
      if (block?.arguments !== undefined || block?.name !== undefined) {
        upsertTool(target, { id, name: asString(block?.name), args: block?.arguments });
      }
    }
    if (innerType === "toolcall_end" || innerType === "tool_call_end") {
      const target = ensureAssistant();
      const call = isRecord(inner.toolCall) ? inner.toolCall : toolCallFromPartial(inner);
      const id = resolveToolId(target, asString(call?.id) ?? asString(inner.id));
      // This closes the model's streamed tool-call message, not the tool's actual
      // execution. The SDK emits `tool_execution_start` immediately afterwards and
      // `tool_execution_end` only after the extension has returned. Keep the call
      // running here so consumers such as the live todo panel cannot publish a
      // partial list before the tool has really finished.
      upsertTool(target, {
        id,
        name: asString(call?.name),
        args: call?.arguments,
        result: toolText(inner.result) ?? toolText(inner.output),
        status: "running",
      });
    }
    if (innerType === "done") {
      // Closes one assistant message, not the run. A `toolUse` stop means the agent
      // is about to execute tools and start another turn, so the working state has
      // to survive it — otherwise it flips off and on at every tool boundary.
      const reason = asString(inner.reason);
      if (reason !== "toolUse") nextStreaming = false;
      // A terminal round-trip ends the reply: stamp the finish so the footer can
      // report the end time and the duration. `toolUse` is deliberately excluded —
      // the reply continues into another round-trip, so its real end is later.
      // Main's transcript read re-stamps this authoritatively from the session
      // entry and a failed turn keeps the optimistic bubble (the reload is skipped
      // to preserve the error), so that path is covered below.
      if (reason !== "toolUse") ensureAssistant().completedAt = Date.now();
    }
    if (innerType === "error") {
      nextStreaming = false;
      const aborted =
        asString(inner.reason) === "aborted" ||
        (isRecord(inner.error) && inner.error.stopReason === "aborted") ||
        (isRecord(inner.message) && inner.message.stopReason === "aborted");
      // The round-trip stopped here — a failure or a user abort is still an end, and
      // a failed turn never gets the authoritative transcript re-stamp (the reload is
      // skipped so the error bubble survives), so this is the only reading it gets.
      ensureAssistant().completedAt = Date.now();
      if (!aborted) {
        const error =
          errorFromAssistant(inner.error) ??
          errorFromAssistant(inner.message) ??
          asString(inner.errorMessage) ??
          (i18n.t("common:errors.requestFailed") as string);
        ensureAssistant().error = error;
      }
    }
    // After the inner event, so a freshly opened thinking part is the one stamped.
    const trailing = next.at(-1);
    if (trailing?.role === "assistant") stampThinkingTiming(trailing, event);
    return { messages: next, streaming: nextStreaming };
  }

  if (type === "auto_retry_start") {
    const error = asString(event.errorMessage);
    const last = next.at(-1);
    if (last?.role === "assistant") {
      const attempt = typeof event.attempt === "number" ? event.attempt : 1;
      const maxAttempts = typeof event.maxAttempts === "number" ? event.maxAttempts : undefined;
      const delayMs = typeof event.delayMs === "number" ? event.delayMs : undefined;
      const retry =
        maxAttempts != null
          ? (i18n.t("common:errors.retryingWithBudget", { attempt, maxAttempts }) as string) +
            (delayMs ? (i18n.t("common:errors.retryAfter", { seconds: Math.round(delayMs / 1000) }) as string) : "") +
            (error ? (i18n.t("common:errors.retryDetail", { error }) as string) : "")
          : (i18n.t("common:errors.retrying") as string) +
            (error ? (i18n.t("common:errors.retryDetail", { error }) as string) : "");
      const list = next.slice();
      list[list.length - 1] = { ...last, error: retry };
      return { messages: list, streaming: true };
    }
    return { messages: next, streaming: true };
  }

  if (type === "auto_retry_end") {
    const last = next.at(-1);
    if (last?.role === "assistant" && event.success === true) {
      return { messages: clearTrailingAssistantErrors(next), streaming: nextStreaming };
    }
    if (last?.role === "assistant" && event.success === false) {
      const error = asString(event.finalError) ?? last.error ?? (i18n.t("common:errors.requestFailed") as string);
      const list = next.slice();
      list[list.length - 1] = { ...last, error };
      return { messages: list, streaming: false };
    }
    return { messages: next, streaming: nextStreaming };
  }

  if (type === "tool_execution_update") {
    const existing = trailingAssistant(next);
    if (existing) {
      const target = ensureAssistant();
      const id = resolveToolId(target, asString(event.toolCallId) ?? asString(event.id));
      const partial = toolText(event.partialResult) ?? toolText(event.result) ?? toolText(event.output);
      if (partial) upsertTool(target, { id, result: partial });
    }
    return { messages: next, streaming: nextStreaming };
  }

  if (type === "tool_execution_start" || type === "toolcall_start") {
    const target = ensureAssistant();
    const id = resolveToolId(target, asString(event.toolCallId) ?? asString(event.id));
    // This event carries the authoritative name/args even when the streaming
    // tool-call block could not be resolved.
    upsertTool(target, {
      id,
      name: asString(event.toolName) ?? asString(event.name),
      args: event.args ?? event.arguments,
      status: "running",
    });
    nextStreaming = true;
    return { messages: next, streaming: nextStreaming };
  }

  if (type === "tool_execution_end" || type === "toolcall_end") {
    const existing = trailingAssistant(next);
    if (existing) {
      const target = ensureAssistant();
      const id = resolveToolId(target, asString(event.toolCallId) ?? asString(event.id));
      upsertTool(target, {
        id,
        name: asString(event.toolName),
        result: toolText(event.result) ?? toolText(event.output),
        details: toolDetails(event.result) ?? event.details,
        status: event.isError === true ? "error" : "done",
      });
    }
    return { messages: next, streaming: nextStreaming };
  }

  if (type === "extension_error") {
    const text = asString(event.error) ?? "extension error";
    return {
      messages: appendMessage(next, {
        id: crypto.randomUUID(),
        role: "system",
        text,
        tools: [],
        parts: [{ kind: "text", text }],
        createdAt: Date.now(),
      }),
      streaming: nextStreaming,
    };
  }

  return { messages: next, streaming: nextStreaming };
}
