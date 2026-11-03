import type { BotChatMessage } from "../../../shared/bot.ts";
import type { ChatMessage } from "../../../shared/types.ts";

/**
 * The main Vivi surface consumes the durable Router chat channel. It never derives
 * user-visible rows from an SDK transcript; Worker execution remains in its own pane.
 * Stored Worker results are for delivery/recovery. Only the Router briefs them in chat.
 */
export function botChatMessages(messages: readonly BotChatMessage[]): ChatMessage[] {
  return messages.filter((message) => message.kind !== "result").map((message) => ({
    id: message.id,
    role: message.kind && message.kind !== "message" ? "system" : message.role,
    text: message.text,
    ...(message.attachments?.length ? { attachments: message.attachments } : {}),
    tools: [],
    parts: [{ kind: "text", text: message.text }],
    createdAt: message.createdAt,
    kind: "message",
    bot: { kind: message.kind ?? "message", conversationId: message.conversationId, title: message.title, result: message.result },
  }));
}
