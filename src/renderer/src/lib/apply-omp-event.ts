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

function lastAssistant(messages: ChatMessage[]): ChatMessage | undefined {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i].role === "assistant") return messages[i];
  }
  return undefined;
}

function ensureAssistant(messages: ChatMessage[]): ChatMessage {
  const existing = lastAssistant(messages);
  if (existing) return existing;
  const created: ChatMessage = {
    id: crypto.randomUUID(),
    role: "assistant",
    text: "",
    tools: [],
    createdAt: Date.now(),
  };
  messages.push(created);
  return created;
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

function cloneMessages(messages: ChatMessage[]): ChatMessage[] {
  return messages.map((message) => ({
    ...message,
    tools: message.tools.map((tool) => ({ ...tool })),
  }));
}

export function applyOmpEvent(
  messages: ChatMessage[],
  event: OmpWireEvent,
  streaming: boolean,
): ApplyResult {
  const next = cloneMessages(messages);
  let nextStreaming = streaming;
  const type = event.type;

  if (type === "agent_start" || type === "turn_start") {
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
    next.push({
      id: crypto.randomUUID(),
      role: "system",
      text,
      tools: [],
      createdAt: Date.now(),
    });
    return { messages: next, streaming: nextStreaming };
  }

  if (type === "command_output") {
    const text = asString(event.output) ?? asString(event.text) ?? toolText(event.data);
    if (text) {
      const assistant = ensureAssistant(next);
      assistant.text = assistant.text ? `${assistant.text}\n${text}` : text;
    }
    return { messages: next, streaming: nextStreaming };
  }

  if (type === "compaction_start" || type === "auto_compaction_start") {
    next.push({
      id: crypto.randomUUID(),
      role: "system",
      text: "正在压缩上下文…",
      tools: [],
      createdAt: Date.now(),
      kind: "compact",
    });
    return { messages: next, streaming: nextStreaming };
  }

  if (type === "compaction_end" || type === "auto_compaction_end") {
    const last = next.at(-1);
    if (last?.kind === "compact") {
      last.text = event.aborted === true ? "上下文压缩已取消。" : "上下文已压缩。";
    }
    return { messages: next, streaming: nextStreaming };
  }

  if (type === "todo_reminder" || type === "todo_auto_clear") {
    const text = asString(event.message) ?? asString(event.reminder) ?? (type === "todo_auto_clear" ? "待办已清空" : "待办提醒");
    next.push({
      id: crypto.randomUUID(),
      role: "system",
      text,
      tools: [],
      createdAt: Date.now(),
      kind: "notice",
    });
    return { messages: next, streaming: nextStreaming };
  }

  if (type === "goal_updated") {
    const text = asString(event.goal) ?? asString(event.message) ?? toolText(event.data);
    if (text) {
      next.push({
        id: crypto.randomUUID(),
        role: "system",
        text,
        tools: [],
        createdAt: Date.now(),
        kind: "goal",
      });
    }
    return { messages: next, streaming: nextStreaming };
  }

  if (type === "message_update") {
    const inner = isRecord(event.assistantMessageEvent) ? event.assistantMessageEvent : null;
    const innerType = asString(inner?.type);
    if (innerType === "text_delta" && inner) {
      const delta = asString(inner.delta) ?? asString(inner.text) ?? "";
      if (delta) {
        const assistant = ensureAssistant(next);
        assistant.text += delta;
        nextStreaming = true;
      }
    }
    if (innerType === "thinking_delta" && inner) {
      const delta = asString(inner.delta) ?? asString(inner.text) ?? "";
      if (delta) {
        const assistant = ensureAssistant(next);
        assistant.thinking = `${assistant.thinking ?? ""}${delta}`;
        nextStreaming = true;
      }
    }
    if ((innerType === "toolcall_start" || innerType === "tool_call_start") && inner) {
      const assistant = ensureAssistant(next);
      upsertTool(assistant, {
        id: asString(inner.id) ?? crypto.randomUUID(),
        name: asString(inner.name) ?? "tool",
        args: inner.arguments ?? inner.args ?? inner.input,
        status: "running",
      });
      nextStreaming = true;
    }
    if ((innerType === "toolcall_delta" || innerType === "tool_call_delta") && inner) {
      const assistant = lastAssistant(next);
      const id = asString(inner.id) ?? assistant?.tools.at(-1)?.id;
      if (assistant && id) {
        const delta = asString(inner.delta) ?? toolText(inner.partialResult);
        if (delta) {
          const existing = assistant.tools.find((tool) => tool.id === id);
          upsertTool(assistant, { id, result: `${existing?.result ?? ""}${delta}` });
        }
      }
    }
    if ((innerType === "toolcall_end" || innerType === "tool_call_end") && inner) {
      const assistant = lastAssistant(next);
      const id = asString(inner.id) ?? assistant?.tools.at(-1)?.id;
      if (assistant && id) {
        upsertTool(assistant, {
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
    const assistant = lastAssistant(next);
    const id = asString(event.toolCallId) ?? asString(event.id) ?? assistant?.tools.at(-1)?.id;
    if (assistant && id) {
      upsertTool(assistant, {
        id,
        result: toolText(event.result) ?? toolText(event.output) ?? toolText(event.partialResult),
      });
    }
    return { messages: next, streaming: nextStreaming };
  }

  if (type === "tool_execution_start" || type === "toolcall_start") {
    const assistant = ensureAssistant(next);
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
    upsertTool(assistant, {
      id,
      name,
      args: event.args ?? event.arguments,
      status: "running",
    });
    nextStreaming = true;
    return { messages: next, streaming: nextStreaming };
  }

  if (type === "tool_execution_end" || type === "toolcall_end") {
    const assistant = lastAssistant(next);
    if (assistant) {
      const id =
        asString(event.toolCallId) ??
        asString(event.id) ??
        assistant.tools.at(-1)?.id ??
        crypto.randomUUID();
      upsertTool(assistant, {
        id,
        result: toolText(event.result) ?? toolText(event.output),
        status: event.isError === true ? "error" : "done",
      });
    }
    return { messages: next, streaming: nextStreaming };
  }

  if (type === "extension_error") {
    next.push({
      id: crypto.randomUUID(),
      role: "system",
      text: asString(event.error) ?? "extension error",
      tools: [],
      createdAt: Date.now(),
    });
  }

  return { messages: next, streaming: nextStreaming };
}
