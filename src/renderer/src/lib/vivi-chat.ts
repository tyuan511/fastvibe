import type { BotChatMessage } from "../../../shared/bot.ts";
import type { ChatMessage } from "../../../shared/types.ts";

/**
 * The main Vivi surface consumes the durable Router chat channel. It never derives
 * user-visible rows from an SDK transcript; Worker execution remains in its own pane.
 */
export function botChatMessages(messages: readonly BotChatMessage[]): ChatMessage[] {
  return messages.map((message) => ({
    id: message.id,
    role: message.role,
    text: message.text,
    ...(message.attachments?.length ? { attachments: message.attachments } : {}),
    tools: [],
    parts: [{ kind: "text", text: message.text }],
    createdAt: message.createdAt,
    kind: "message",
  }));
}
