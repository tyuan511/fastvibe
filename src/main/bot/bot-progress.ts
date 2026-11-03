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

export function isStatusQuestion(text: string): boolean {
  const normalized = text.trim().toLocaleLowerCase().replace(/[？。！!?.]+$/gu, "").replace(/\s+/gu, " ");
  return new Set([
    "现在到哪了", "现在进度怎么样", "进度怎么样", "现在进度", "目前进展", "做到哪了", "做到哪里了", "目前怎么样",
    "what is the status", "what's the status", "what is the progress", "any progress", "status update",
  ]).has(normalized);
}

export function statusText(progress: BotProgress, attention: readonly BotAttention[], zh = true): string {
  const waiting = attention.some((item) => item.status === "pending" && item.conversationId === progress.conversationId);
  if (waiting || progress.phase === "waiting") return zh ? "我正在等你回答一个问题，回答后会继续。" : "I’m waiting for your answer before I continue.";
  if (progress.phase === "accepted") return zh ? "我已经收到，正在开始处理。" : "I’ve received it and am getting started.";
  if (progress.phase === "understanding") return zh ? "我正在理解你的要求，先确认需要处理的范围。" : "I’m understanding the request and checking its scope.";
  if (progress.phase === "planning") return progress.detail ?? (zh ? "我正在梳理处理步骤。" : "I’m working out the next steps.");
  if (progress.phase === "delegating") return zh ? "我已安排处理，正在推进。" : "I’ve arranged the work and it is moving forward.";
  if (progress.phase === "working" || progress.phase === "summarizing") return progress.detail ? (zh ? `我正在处理：${progress.detail}` : `I’m working on: ${progress.detail}`) : (zh ? "我正在处理这件事。" : "I’m working on it.");
  if (progress.phase === "completed" && progress.role === "router" && !progress.result) return zh ? "你的消息已经处理；目前没有正在执行的工作。" : "Your message has been handled; no work is currently running.";
  if (progress.phase === "completed") return progress.detail ? (zh ? `最近的结果是：${progress.detail}` : `The latest result is: ${progress.detail}`) : (zh ? "最近一项工作已经完成。" : "The latest piece of work is complete.");
  if (progress.phase === "idle" && progress.result) return zh ? `已有进展，但尚未确认完成${progress.detail ? `：${progress.detail}` : "。"}` : `Progress was saved, but completion is unconfirmed${progress.detail ? `: ${progress.detail}` : "."}`;
  if (progress.phase === "failed") return progress.detail ? (zh ? `这件事遇到了问题：${progress.detail}` : `This ran into a problem: ${progress.detail}`) : (zh ? "这件事遇到了问题，我保留了已有结果。" : "This ran into a problem; I kept the results already produced.");
  if (progress.phase === "interrupted" || progress.phase === "paused") return zh ? "这件事暂时停下了，可以点击继续。" : "This is paused for now; you can continue it.";
  return zh ? "目前没有正在处理的事情。" : "Nothing is currently in progress.";
}

export function statusTextForProgress(progresses: readonly BotProgress[], attention: readonly BotAttention[], zh = true): string {
  const live = progresses.filter((item) => ACTIVE_PHASES.has(item.phase) && item.phase !== "waiting");
  const waiting = attention.filter((item) => item.status === "pending");
  const lines = live.slice(0, 3).map((item) => zh
    ? `正在处理「${item.title ?? "你的要求"}」：${statusText(item, [], true)}`
    : `I’m working on “${item.title ?? "your request"}”: ${statusText(item, [], false)}`);
  if (live.length > 3) lines.push(zh ? `另外还有 ${live.length - 3} 件事正在处理。` : `${live.length - 3} more items are in progress.`);
  if (waiting.length) lines.push(zh ? `需要你回答「${waiting[0].question}」，回答后会继续。` : `I need your answer to “${waiting[0].question}” to continue.`);
  if (lines.length) return lines.join("\n");
  const relevant = progresses.filter((item) => item.role === "worker" || item.result);
  const candidates = relevant.length ? relevant : progresses;
  const recent = candidates.slice().sort((a, b) => b.updatedAt - a.updatedAt).find((item) => item.phase !== "idle" || item.result);
  if (recent) return statusText(recent, attention, zh);
  return zh ? "目前没有正在处理的事情。" : "Nothing is currently in progress.";
}

export function progressIsActive(phase: BotProgressPhase): boolean { return ACTIVE_PHASES.has(phase); }
