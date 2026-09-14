import type { ChatMessage, EngineEvent, ToolCallBlock } from "@shared/types";

export type ApplyResult = {
  messages: ChatMessage[];
  streaming: boolean;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
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
    parts[parts.length - 1] = kind === "text" ? { kind: "text", text } : { kind: "thinking", text };
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
    ensureAssistant();
    return { messages: next, streaming: true };
  }

  if (type === "turn_end") {
    // A turn ending is not a run ending. `turn_end` fires after every assistant
    // message — including each one that only requested a tool call — and the agent
    // immediately feeds the tool results back into another turn. Clearing the
    // working state here made the footer, caret and "working" row blink once per
    // tool call. Only `agent_end` closes the run.
    return { messages: next, streaming: nextStreaming };
  }

  if (type === "agent_end") {
    return { messages: next, streaming: false };
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
      messages: appendMessage(next, {
        id: crypto.randomUUID(),
        role: "system",
        text: "正在压缩上下文…",
        tools: [],
        parts: [{ kind: "text", text: "正在压缩上下文…" }],
        createdAt: Date.now(),
        kind: "compact",
      }),
      streaming: nextStreaming,
    };
  }

  if (type === "compaction_end" || type === "auto_compaction_end") {
    const last = next.at(-1);
    if (last?.kind === "compact") {
      const text = event.aborted === true ? "上下文压缩已取消。" : "上下文已压缩。";
      const list = next.slice();
      list[list.length - 1] = { ...last, text, parts: [{ kind: "text", text }] };
      return { messages: list, streaming: nextStreaming };
    }
    return { messages: next, streaming: nextStreaming };
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

  if (type === "goal_updated") {
    const text = asString(event.goal) ?? asString(event.message) ?? toolText(event.data);
    if (text) {
      return {
        messages: appendMessage(next, {
          id: crypto.randomUUID(),
          role: "system",
          text,
          tools: [],
          parts: [{ kind: "text", text }],
          createdAt: Date.now(),
          kind: "goal",
        }),
        streaming: nextStreaming,
      };
    }
    return { messages: next, streaming: nextStreaming };
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
