import type { ChatMessage } from "../../../shared/types.ts";

export type ViviChatHost = {
  create: () => Promise<string>;
  isRunning: (id: string) => boolean;
  created: (id: string) => void;
  submit: (request: { conversationId: string; text: string; enqueue: boolean }) => Promise<unknown>;
};

export async function sendViviMessage(host: ViviChatHost, text: string, conversationId?: string): Promise<string> {
  const message = text.trim();
  if (!message) throw new Error("Empty message");
  const id = conversationId ?? await host.create();
  if (!conversationId) host.created(id);
  await host.submit({ conversationId: id, text: message, enqueue: host.isRunning(id) });
  return id;
}

export function viviLatestReply(messages: readonly ChatMessage[]): string {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message.role === "user") break;
    if (message.role === "assistant" && message.text.trim()) return message.text;
  }
  return "";
}
