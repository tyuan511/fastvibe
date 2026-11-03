import type { BotAttention, BotConversationMeta } from "../../../shared/bot.ts";
import type { PermissionRequest } from "../../../shared/types.ts";

export type ViviRequest = {
  key: string;
  conversationId: string;
  title?: string;
} & ({ kind: "plugin"; request: PermissionRequest } | { kind: "question"; question: BotAttention });

/** Keep original identities: the request id routes plugin answers to its host. */
export function collectViviRequests(
  conversations: BotConversationMeta[],
  attention: BotAttention[],
  pending: Record<string, PermissionRequest[]>,
): ViviRequest[] {
  const items: ViviRequest[] = [];
  const seen = new Set<string>();
  const owners = new Map(conversations.map((meta) => [meta.conversationId, meta]));
  for (const [conversationId, requests] of Object.entries(pending)) {
    const owner = owners.get(conversationId);
    if (!owner) continue;
    for (const request of requests) {
      const key = `plugin:${request.id}`;
      if (seen.has(key) || (request.conversationId && request.conversationId !== conversationId)) continue;
      seen.add(key);
      items.push({ key, kind: "plugin", conversationId, title: owner.title, request });
    }
  }
  for (const question of attention) {
    const owner = owners.get(question.conversationId);
    const key = `question:${question.id}`;
    if (!owner || question.status !== "pending" || question.epoch !== owner.epoch || seen.has(key)) continue;
    seen.add(key);
    items.push({ key, kind: "question", conversationId: question.conversationId, title: owner.title, question });
  }
  return items;
}
