import type { BotAttention, BotConversationMeta, BotInput, BotProgress, BotProgressPhase, BotResult } from "../../shared/bot.ts";

const ACTIVE_PHASES = new Set<BotProgressPhase>(["accepted", "understanding", "planning", "delegating", "working", "waiting", "summarizing"]);

export function progressPhaseFor(input: BotInput | undefined, conversation: BotConversationMeta, attention: readonly BotAttention[], result?: BotResult): BotProgressPhase {
  const pendingQuestion = attention.some((item) => item.status === "pending" && item.conversationId === conversation.conversationId && item.epoch === conversation.epoch);
  if (pendingQuestion) return "waiting";
  if (!input) return conversation.paused ? "paused" : "idle";
  if (input.status === "queued" || input.status === "accepted") return "accepted";
  if (input.status === "running") {
    if (conversation.paused) return attention.some((item) => item.status === "pending" && item.epoch === conversation.epoch) ? "waiting" : "paused";
    return input.progress?.phase ?? (conversation.role === "router" ? input.source === "report" ? "summarizing" : "understanding" : "working");
  }
  if (input.status === "uncertain") return conversation.paused ? "paused" : "interrupted";
  if (input.status === "failed") return "failed";
  if (input.status === "canceled") return "paused";
  if (result?.status === "failed") return "failed";
  if (result?.status === "uncertain") return "interrupted";
  if (result?.status === "blocked") return "failed";
  if (result && result.status !== "idle") return "completed";
  if (input.status === "completed" && conversation.role === "router") return "completed";
  return "idle";
}
export function latestInputFor(inputs: readonly BotInput[], conversationId: string, epoch: number): BotInput | undefined {
  const eligible = inputs.filter((input) => input.conversationId === conversationId && input.epoch === epoch && input.intent !== "status");
  const active = eligible.filter((input) => input.status === "running" || input.status === "queued" || input.status === "accepted");
  const candidates = active.length ? active : eligible;
  return candidates.slice().sort((a, b) => {
    const rank = (value: BotInput): number => value.status === "running" ? 3 : value.status === "queued" || value.status === "accepted" ? 2 : 1;
    return rank(b) - rank(a) || b.createdAt - a.createdAt || b.id.localeCompare(a.id);
  })[0];
}

export function deriveBotProgress(conversation: BotConversationMeta, inputs: readonly BotInput[], attention: readonly BotAttention[], results: readonly BotResult[]): BotProgress {
  const own = inputs.filter((input) => input.conversationId === conversation.conversationId && input.epoch === conversation.epoch && input.intent !== "status");
  const current = latestInputFor(inputs, conversation.conversationId, conversation.epoch);
  const delegated = current && conversation.role === "router" && inputs.some((input) => input.conversationId !== conversation.conversationId && input.rootInputId === (current.rootInputId ?? current.id) && (input.status === "queued" || input.status === "running"));
  const result = current ? [...results].reverse().find((item) => item.conversationId === conversation.conversationId && item.inputId === current.id) : undefined;
  const pending = own.filter((input) => input.status === "queued").length;
  const phase = delegated && current?.status === "running" ? "delegating" : progressPhaseFor(current, conversation, attention, result);
  const pendingQuestion = attention.find((item) => item.conversationId === conversation.conversationId && item.epoch === conversation.epoch && item.status === "pending");
  const terminal = !["queued", "accepted", "running"].includes(current?.status ?? "");
  return {
    conversationId: conversation.conversationId,
    inputId: current?.id,
    rootInputId: current?.rootInputId ?? current?.id,
    role: conversation.role,
    title: conversation.title,
    phase,
    detail: pendingQuestion?.question ?? (terminal ? result?.summary ?? current?.error : delegated ? undefined : current?.progress?.text),
    startedAt: current?.startedAt ?? current?.createdAt ?? conversation.updatedAt,
    updatedAt: terminal ? current?.completedAt ?? result?.createdAt ?? current?.createdAt ?? conversation.updatedAt : current?.progress?.updatedAt ?? current?.createdAt ?? conversation.updatedAt,
    queuedCount: pending,
    ...(result ? { result } : {}),
  };
}

export function progressIsActive(phase: BotProgressPhase): boolean { return ACTIVE_PHASES.has(phase); }
