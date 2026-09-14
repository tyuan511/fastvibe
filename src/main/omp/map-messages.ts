import type { ChatAttachment, ChatMessage, ToolCallBlock } from "@shared/types";

export function mapEngineMessages(raw: unknown): ChatMessage[] {
  if (!Array.isArray(raw)) return [];
  const output: ChatMessage[] = [];
  for (const entry of raw) {
    const message = unwrapMessage(entry);
    if (!message) continue;
    if (message.role === "toolResult") {
      const id = String(message.toolCallId ?? "");
      const result = toolText(message.content ?? message.result ?? message.output);
      if (id && result) {
        const assistant = [...output].reverse().find((item) => item.role === "assistant" && item.tools.some((tool) => tool.id === id));
        const tool = assistant?.tools.find((item) => item.id === id);
        if (tool) {
          tool.result = result;
          tool.status = message.isError === true ? "error" : "done";
        }
      }
      continue;
    }
    const role = message.role === "assistant" || message.role === "system" ? message.role : "user";
    const { text, thinking, tools, attachments } = extractContent(message.content);
    if (!text && !thinking && tools.length === 0 && attachments.length === 0 && role !== "assistant") continue;
    output.push({
        id: String(message.id ?? crypto.randomUUID()),
        role,
        text,
        thinking,
        tools,
        createdAt: typeof message.timestamp === "number" ? message.timestamp : Date.now(),
        kind: role === "system" ? "notice" : "message",
        attachments: attachments.length > 0 ? attachments : undefined,
      });
  }
  return output;
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
} {
  if (typeof content === "string") return { text: content, tools: [], attachments: [] };
  if (!Array.isArray(content)) return { text: "", tools: [], attachments: [] };
  const texts: string[] = [];
  const thoughts: string[] = [];
  const tools: ToolCallBlock[] = [];
  const attachments: ChatAttachment[] = [];
  const results = new Map<string, string>();

  for (const part of content) {
    if (typeof part === "string") {
      texts.push(part);
      continue;
    }
    if (!isRecord(part)) continue;
    const type = String(part.type ?? "");
    if (typeof part.text === "string" && type !== "thinking") texts.push(part.text);
    if (type === "thinking") {
      const thought = typeof part.thinking === "string" ? part.thinking : typeof part.text === "string" ? part.text : "";
      if (thought) thoughts.push(thought);
    }
    if (type === "tool_use" || type === "toolcall" || type === "tool_call" || type === "toolCall") {
      tools.push({
        id: String(part.id ?? crypto.randomUUID()),
        name: String(part.name ?? "tool"),
        args: part.arguments ?? part.input ?? part.args,
        status: "done",
      });
    }
    if (type === "image" && typeof part.data === "string") {
      const mime = typeof part.mimeType === "string" ? part.mimeType : "image/png";
      attachments.push({
        id: crypto.randomUUID(),
        kind: "image",
        name: "image",
        mimeType: mime,
        dataUrl: `data:${mime};base64,${part.data}`,
      });
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
  };
}

function toolText(value: unknown): string | undefined {
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
