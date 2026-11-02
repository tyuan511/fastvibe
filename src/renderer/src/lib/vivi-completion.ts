import type { ChatMessage } from "../../../shared/types.ts";
import type { BotDelivery } from "../../../shared/bot.ts";

/** Read the completed turn's final request, never earlier progress prose. */
export function completedViviReply(messages: readonly ChatMessage[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role === "user") break;
    if (message.role !== "assistant" || (message.kind !== undefined && message.kind !== "message")) continue;
    if (message.error || message.stop || message.retry || message.id.startsWith("running:") || message.tools.length > 0) return "";
    return message.text.trim();
  }
  return "";
}

export type ViviCompletion = { conversationId: string; text: string; revision: number; runId?: string };
export type ViviCompletionRequest = { conversationId: string; revision: number };

/** One display slot: latest completion wins, regardless of fetch completion order. */
export class ViviCompletionState {
  #revision = 0;
  #pending: ViviCompletionRequest | undefined;
  #deliveries = new Set<string>();
  completion: ViviCompletion | undefined;

  /** A Bot delivery is already the final result; do not re-read a Router that may have moved on. */
  deliver(delivery: Pick<BotDelivery, "id" | "conversationId" | "text">, visible: boolean): boolean {
    if (this.#deliveries.has(delivery.id)) return false;
    this.#deliveries.add(delivery.id);
    if (this.#deliveries.size > 256) this.#deliveries.delete(this.#deliveries.values().next().value!);
    this.#pending = undefined;
    if (!visible || !delivery.text.trim()) return false;
    this.completion = {
      conversationId: delivery.conversationId, text: delivery.text.trim(), revision: ++this.#revision,
    };
    return true;
  }

  event(event: { type: string; conversationId?: unknown; status?: unknown; running?: unknown }): ViviCompletionRequest | undefined {
    const id = event.conversationId;
    if (typeof id !== "string" || !id) return;
    if ((event.type === "conversation_running" && event.running === true)
      || event.type === "agent_start" || (event.type === "conversation_activity" && event.status !== "completed")) {
      if (this.#pending?.conversationId === id) this.#pending = undefined;
      if (this.completion?.conversationId === id && !this.completion.runId) this.completion = undefined;
      return;
    }
    if (event.type !== "conversation_activity" || event.status !== "completed") return;
    const request = { conversationId: id, revision: ++this.#revision };
    this.#pending = request;
    return request;
  }

  accept(request: ViviCompletionRequest, snapshot: { conversationId: string | null; running: boolean; messages: readonly ChatMessage[] }): boolean {
    if (this.#pending !== request || snapshot.conversationId !== request.conversationId || snapshot.running) return false;
    this.#pending = undefined;
    const text = completedViviReply(snapshot.messages);
    if (!text) return false;
    this.completion = { ...request, text };
    return true;
  }
}
