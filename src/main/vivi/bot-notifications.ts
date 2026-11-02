import type { BotConversationMeta, WorkSnapshot } from "../../shared/bot.ts";

export type BotAttention = { id: string; conversationId: string; kind: "question" | "failed"; title: string; text: string };

/** Durable facts supply identity; UI focus controls when an unread fact is first announced. */
export class BotAttentionNotices {
  #announced = new Set<string>();
  take(snapshot: WorkSnapshot, options: { enabled: boolean; focused: boolean; viewingVivi: boolean }): BotAttention[] {
    const byId = new Map(snapshot.conversations.map((conversation) => [conversation.conversationId, conversation]));
    const candidates: BotAttention[] = [];
    for (const question of snapshot.attention) {
      if (question.status !== "pending") continue;
      const conversation = byId.get(question.conversationId);
      candidates.push({ id: question.id, conversationId: question.conversationId, kind: "question", title: titleOf(conversation), text: question.question });
    }
    for (const result of snapshot.results) {
      if (result.status !== "failed" && result.status !== "blocked" && result.status !== "uncertain") continue;
      const conversation = byId.get(result.conversationId);
      candidates.push({ id: result.id, conversationId: result.conversationId, kind: "failed", title: titleOf(conversation), text: result.summary ?? "" });
    }
    const current = new Set(candidates.map((candidate) => candidate.id));
    for (const id of this.#announced) if (!current.has(id)) this.#announced.delete(id);
    if (!options.enabled) return [];
    return candidates.filter((candidate) => {
      if (this.#announced.has(candidate.id)) return false;
      if (options.focused && (candidate.kind === "failed" || options.viewingVivi)) return false;
      this.#announced.add(candidate.id);
      return true;
    });
  }
}

function titleOf(conversation: BotConversationMeta | undefined): string {
  return conversation?.title || (conversation?.role === "router" ? "Vivi" : "工作会话");
}
