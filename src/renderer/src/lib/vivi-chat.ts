import type { ChatMessage } from "../../../shared/types.ts";

export function viviLatestReply(messages: readonly ChatMessage[]): string {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message.role === "user") break;
    if (message.role === "assistant" && message.text.trim()) return message.text;
  }
  return "";
}
