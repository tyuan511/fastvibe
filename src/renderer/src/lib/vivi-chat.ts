import type { BotChatMessage, BotExecutionError, WorkSnapshot } from "../../../shared/bot.ts";
import type { ChatMessage } from "../../../shared/types.ts";

/** An in-flight optimistic prompt from before /clear must not resurrect the cleared feed. */
export function viviFeedWithOptimistic(snapshot: Pick<WorkSnapshot, "messages" | "chatGeneration"> | null, optimistic: BotChatMessage | null): BotChatMessage[] {
  const stored = snapshot?.messages ?? [];
  if (!optimistic || (optimistic.historyGeneration ?? 0) !== (snapshot?.chatGeneration ?? 0)
    || stored.some((message) => message.id === optimistic.id)) return stored;
  return [...stored, optimistic];
}

/**
 * The main Vivi surface consumes the durable Router chat channel. It never derives
 * user-visible rows from an SDK transcript; Worker execution remains in its own pane.
 * Stored Worker results are for delivery/recovery. Only the Router briefs them in chat.
 */
export function botChatMessages(messages: readonly BotChatMessage[], routerId?: string): ChatMessage[] {
  return messages.filter((message) => message.kind !== "result" || (message.result?.status === "failed" && message.conversationId === routerId)).map((message) => ({
    id: message.id,
    role: message.kind && message.kind !== "message" ? "system" : message.role,
    text: message.text,
    ...(message.attachments?.length ? { attachments: message.attachments } : {}),
    tools: [],
    parts: [{ kind: "text", text: message.text }],
    createdAt: message.createdAt,
    kind: "message",
    bot: { kind: message.kind ?? "message", conversationId: message.conversationId, inputId: message.inputId, title: message.title, result: message.result },
    ...(message.kind === "result" && message.result?.status === "failed" ? { error: message.result.summary || message.text } : {}),
  }));
}

/**
 * Timeouts can end as an SDK abort even though the durable receipt records a failure.
 * Keep the request's prose/tools, then show its actual failure once at the end of the
 * conversation, using the same error card as the main chat.
 */
export function viviConversationMessages(messages: ChatMessage[], failure?: BotExecutionError): ChatMessage[] {
  if (!failure || messages.some((message) => message.role !== "system" && message.createdAt > failure.createdAt)) return messages;
  let lastAssistant = -1;
  for (let index = messages.length - 1; index >= 0; index--) {
    if (messages[index].role === "assistant") { lastAssistant = index; break; }
  }
  // Preflight can fail without writing an assistant at all. Earlier turns keep their
  // own errors; only the failed execution's actual tail is replaced by its receipt.
  const visible = messages.map((message, index) => index === lastAssistant && failure.startedAt !== undefined && message.createdAt >= failure.startedAt
    ? { ...message, error: undefined, stop: undefined, retry: undefined }
    : message);
  visible.push({
    id: `vivi-error:${failure.inputId}`, role: "system", text: "", error: failure.error,
    tools: [], parts: [], createdAt: failure.createdAt, kind: "message",
    bot: { kind: "result", conversationId: failure.conversationId, inputId: failure.inputId },
  });
  return visible;
}
