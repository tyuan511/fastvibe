import type { ChatMessage, OmpWireEvent, ToolCallBlock } from "@shared/types";

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
    const assistant: ChatMessage = { ...last, tools: last.tools.map((tool) => ({ ...tool })) };
    const list = messages.slice();
    list[list.length - 1] = assistant;
    return { list, assistant };
  }
  const assistant: ChatMessage = {
    id: crypto.randomUUID(),
    role: "assistant",
    text: "",
    tools: [],
    createdAt: Date.now(),
  };
  return { list: [...messages, assistant], assistant };
}

function appendMessage(messages: ChatMessage[], message: ChatMessage): ChatMessage[] {
  return [...messages, message];
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
    });
    return;
  }
  message.tools[index] = { ...message.tools[index], ...patch };
}

export function applyOmpEvent(
  messages: ChatMessage[],
  event: OmpWireEvent,
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

  if (type === "agent_end" || type === "turn_end") {
    if (event.isTerminal === false) {
      return { messages: next, streaming: true };
    }
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
        createdAt: Date.now(),
        kind: "compact",
      }),
      streaming: nextStreaming,
    };
  }

  if (type === "compaction_end" || type === "auto_compaction_end") {
    const last = next.at(-1);
    if (last?.kind === "compact") {
      const list = next.slice();
      list[list.length - 1] = {
        ...last,
        text: event.aborted === true ? "上下文压缩已取消。" : "上下文已压缩。",
      };
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
        nextStreaming = true;
      }
    }
    if (innerType === "thinking_delta") {
      const delta = asString(inner.delta) ?? asString(inner.text) ?? "";
      if (delta) {
        const target = ensureAssistant();
        target.thinking = `${target.thinking ?? ""}${delta}`;
        nextStreaming = true;
      }
    }
    if (innerType === "toolcall_start" || innerType === "tool_call_start") {
      const target = ensureAssistant();
      upsertTool(target, {
        id: asString(inner.id) ?? crypto.randomUUID(),
        name: asString(inner.name) ?? "tool",
        args: inner.arguments ?? inner.args ?? inner.input,
        status: "running",
      });
      nextStreaming = true;
    }
    if (innerType === "toolcall_delta" || innerType === "tool_call_delta") {
      const existing = trailingAssistant(next);
      const id = asString(inner.id) ?? existing?.tools.at(-1)?.id;
      if (existing && id) {
        const delta = asString(inner.delta) ?? toolText(inner.partialResult);
        if (delta) {
          const target = ensureAssistant();
          const tool = target.tools.find((item) => item.id === id);
          upsertTool(target, { id, result: `${tool?.result ?? ""}${delta}` });
        }
      }
    }
    if (innerType === "toolcall_end" || innerType === "tool_call_end") {
      const existing = trailingAssistant(next);
      const id = asString(inner.id) ?? existing?.tools.at(-1)?.id;
      if (existing && id) {
        const target = ensureAssistant();
        upsertTool(target, {
          id,
          result: toolText(inner.result) ?? toolText(inner.output),
          status: inner.isError === true ? "error" : "done",
        });
      }
    }
    if (innerType === "done") {
      nextStreaming = false;
    }
    return { messages: next, streaming: nextStreaming };
  }

  if (type === "tool_execution_update") {
    const existing = trailingAssistant(next);
    const id = asString(event.toolCallId) ?? asString(event.id) ?? existing?.tools.at(-1)?.id;
    if (existing && id) {
      const target = ensureAssistant();
      upsertTool(target, {
        id,
        result: toolText(event.result) ?? toolText(event.output) ?? toolText(event.partialResult),
      });
    }
    return { messages: next, streaming: nextStreaming };
  }

  if (type === "tool_execution_start" || type === "toolcall_start") {
    const target = ensureAssistant();
    const id =
      asString(event.toolCallId) ??
      asString(event.id) ??
      asString(isRecord(event.assistantMessageEvent) ? event.assistantMessageEvent.id : undefined) ??
      crypto.randomUUID();
    const name =
      asString(event.toolName) ??
      asString(event.name) ??
      asString(isRecord(event.assistantMessageEvent) ? event.assistantMessageEvent.name : undefined) ??
      "tool";
    upsertTool(target, {
      id,
      name,
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
      const id =
        asString(event.toolCallId) ??
        asString(event.id) ??
        target.tools.at(-1)?.id ??
        crypto.randomUUID();
      upsertTool(target, {
        id,
        result: toolText(event.result) ?? toolText(event.output),
        status: event.isError === true ? "error" : "done",
      });
    }
    return { messages: next, streaming: nextStreaming };
  }

  if (type === "extension_error") {
    return {
      messages: appendMessage(next, {
        id: crypto.randomUUID(),
        role: "system",
        text: asString(event.error) ?? "extension error",
        tools: [],
        createdAt: Date.now(),
      }),
      streaming: nextStreaming,
    };
  }

  return { messages: next, streaming: nextStreaming };
}
