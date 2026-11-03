import type { BotConversationMeta, BotProgress, BotResult, WorkSnapshot } from "../../../shared/bot.ts";

export type BotConversationCardStatus = "queued" | "working" | "waiting" | "paused" | "completed" | "failed" | "interrupted" | "blocked" | "unconfirmed" | "idle";
export type BotConversationCardData = {
  conversation: BotConversationMeta;
  preview: string;
  status: BotConversationCardStatus;
  updatedAt: number;
};

const LIVE_PHASES = new Set(["understanding", "planning", "delegating", "working", "summarizing"]);

function cardStatus(conversation: BotConversationMeta, progress: BotProgress | undefined, result: BotResult | undefined, waiting: boolean): BotConversationCardStatus {
  if (waiting) return "waiting";
  if (conversation.paused) return "paused";
  if (progress?.phase === "accepted") return "queued";
  if (progress && LIVE_PHASES.has(progress.phase)) return "working";
  if (progress?.phase === "failed") return result?.status === "blocked" ? "blocked" : "failed";
  if (progress?.phase === "interrupted") return "interrupted";
  if (result?.status === "ready") return "completed";
  if (result?.status === "blocked") return "blocked";
  if (result?.status === "failed") return "failed";
  if (result?.status === "uncertain") return "interrupted";
  if (result?.status === "idle") return "unconfirmed";
  return "idle";
}

/** One projection for preview text, ordering, and status; a newer request owns its verdict. */
export function botConversationCards(snapshot: WorkSnapshot): BotConversationCardData[] {
  const progressById = new Map(snapshot.progress?.map((item) => [item.conversationId, item]));
  const latestResults = new Map<string, BotResult>();
  for (const result of snapshot.results) {
    const previous = latestResults.get(result.conversationId);
    if (!previous || result.createdAt >= previous.createdAt) latestResults.set(result.conversationId, result);
  }
  return snapshot.conversations.filter((conversation) => conversation.role === "worker").map((conversation) => {
    const progress = progressById.get(conversation.conversationId);
    const latestResult = latestResults.get(conversation.conversationId);
    const result = progress?.result ?? (latestResult?.epoch === conversation.epoch && (!progress?.inputId || latestResult.inputId === progress.inputId) ? latestResult : undefined);
    const reply = snapshot.conversationPreviews?.[conversation.conversationId];
    const waiting = snapshot.attention.some((item) => item.conversationId === conversation.conversationId && item.epoch === conversation.epoch && item.status === "pending");
    return {
      conversation,
      preview: (reply?.text || "").replace(/\s+/gu, " ").trim().slice(0, 400),
      status: cardStatus(conversation, progress, result, waiting),
      updatedAt: Math.max(conversation.updatedAt, progress?.updatedAt ?? 0, latestResult?.createdAt ?? 0, reply?.updatedAt ?? 0),
    };
  }).sort((a, b) => b.updatedAt - a.updatedAt || a.conversation.conversationId.localeCompare(b.conversation.conversationId));
}
