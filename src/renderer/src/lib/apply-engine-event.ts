import type { ChatMessage, CompactInfo, CompactReason, EngineEvent, ToolCallBlock } from "@shared/types";

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
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** User aborts stay silent; only `stopReason: "error"` becomes a visible failure. */
function errorFromAssistant(value: unknown): string | undefined {
  if (!isRecord(value) || value.stopReason !== "error") return undefined;
  const text = typeof value.errorMessage === "string" ? value.errorMessage.trim() : "";
  return text || "请求失败";
}

function toolText(value: unknown): string | undefined {
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
 */
function withAssistant(messages: ChatMessage[]): { list: ChatMessage[]; assistant: ChatMessage } {
  const last = messages.at(-1);
  if (last?.role === "assistant") {
    const assistant: ChatMessage = {
      ...last,
      tools: last.tools.map((tool) => ({ ...tool })),
      parts: last.parts ? last.parts.map((part) => ({ ...part })) : [],
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
  const part = message.parts?.at(-1);
  if (!part || part.kind !== "thinking") return;
  if (startedAt !== undefined) part.startedAt = startedAt;
  if (endedAt !== undefined) part.endedAt = endedAt;
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
    const target = ensureAssistant();
    if (target.error) target.error = undefined;
    return { messages: next, streaming: true };
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
        return { messages: list, streaming: false, interrupted };
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
        streaming: false,
        interrupted,
      };
    }
    return { messages: next, streaming: false, interrupted };
  }

  if (type === "prompt_result") {
    if (event.agentInvoked === false) {
      return { messages: next, streaming: false };
    }
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
      (type === "todo_auto_clear" ? "待办已清空" : "待办提醒");
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
      upsertTool(target, {
        id,
        name: asString(call?.name),
        args: call?.arguments,
        result: toolText(inner.result) ?? toolText(inner.output),
        status: inner.isError === true ? "error" : "done",
      });
    }
    if (innerType === "done") {
      // Closes one assistant message, not the run. A `toolUse` stop means the agent
      // is about to execute tools and start another turn, so the working state has
      // to survive it — otherwise it flips off and on at every tool boundary.
      if (asString(inner.reason) !== "toolUse") nextStreaming = false;
    }
    if (innerType === "error") {
      nextStreaming = false;
      const aborted =
        asString(inner.reason) === "aborted" ||
        (isRecord(inner.error) && inner.error.stopReason === "aborted") ||
        (isRecord(inner.message) && inner.message.stopReason === "aborted");
      if (!aborted) {
        const error =
          errorFromAssistant(inner.error) ??
          errorFromAssistant(inner.message) ??
          asString(inner.errorMessage) ??
          "请求失败";
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
          ? `请求失败，正在重试（${attempt}/${maxAttempts}）${delayMs ? `，${Math.round(delayMs / 1000)} 秒后重试` : ""}${error ? `：${error}` : ""}`
          : `请求失败，正在重试${error ? `：${error}` : ""}`;
      const list = next.slice();
      list[list.length - 1] = { ...last, error: retry };
      return { messages: list, streaming: true };
    }
    return { messages: next, streaming: true };
  }

  if (type === "auto_retry_end") {
    const last = next.at(-1);
    if (last?.role === "assistant" && event.success === true) {
      const list = next.slice();
      list[list.length - 1] = { ...last, error: undefined };
      return { messages: list, streaming: nextStreaming };
    }
    if (last?.role === "assistant" && event.success === false) {
      const error = asString(event.finalError) ?? last.error ?? "请求失败";
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
