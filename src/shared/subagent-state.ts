import type { SubagentInfo, ToolCallBlock } from "./types";

type Event = Record<string, unknown>;
const record = (value: unknown): Event | undefined =>
  value !== null && typeof value === "object" ? value as Event : undefined;

export function subagentFinished(status: string | undefined): boolean {
  return status === "completed" || status === "error" || status === "aborted";
}

/** Main and renderer use the same reducer. Only the runner's final lifecycle ends
 * a delegation: agent_end can retry, and agent_settled precedes transcript caching. */
export function reduceSubagent(previous: SubagentInfo | undefined, event: Event, now = Date.now()): SubagentInfo | undefined {
  const id = typeof event.subagentId === "string" ? event.subagentId : "";
  if (!id) return previous;
  const seq = typeof event.seq === "number" ? event.seq : undefined;
  if (seq !== undefined && previous?.revision !== undefined && seq <= previous.revision) return previous;
  const nested = record(event.event);
  let phase: SubagentInfo["phase"] = event.phase === "waiting" || event.phase === "working" ? event.phase : undefined;
  if (event.type === "subagent_event") {
    switch (nested?.type) {
      case "auto_retry_start": phase = "retrying"; break;
      case "compaction_start": phase = "compacting"; break;
      case "agent_start": case "message_start": case "auto_retry_end": case "compaction_end": phase = "working"; break;
      default: return previous;
    }
    if (subagentFinished(previous?.status) || previous?.phase === phase || previous?.phase === "waiting") return previous;
  } else if (!["subagent_lifecycle", "subagent_progress", "subagent_state"].includes(String(event.type))) {
    return previous;
  }
  const model = record(event.model);
  const usage = record(event.contextUsage);
  const status = typeof event.status === "string" ? event.status : previous?.status ?? "running";
  // A delayed running/state event must not resurrect a completed run.
  if (subagentFinished(previous?.status) && status === "running") return previous;
  return {
    ...previous,
    id,
    conversationId: typeof event.conversationId === "string" ? event.conversationId : previous?.conversationId,
    agent: typeof event.agent === "string" ? event.agent : previous?.agent,
    name: typeof event.name === "string" ? event.name : previous?.name,
    status,
    phase: subagentFinished(status) ? undefined : phase ?? previous?.phase ?? "working",
    detail: typeof event.detail === "string" ? event.detail : previous?.detail,
    progress: typeof event.progress === "number" ? event.progress : previous?.progress,
    startedAt: previous?.startedAt ?? now,
    endedAt: subagentFinished(status) ? previous?.endedAt ?? now : previous?.endedAt,
    error: typeof event.error === "string" ? event.error : previous?.error,
    model: model && typeof model.id === "string" && typeof model.provider === "string" ? model as SubagentInfo["model"] : previous?.model,
    thinkingLevel: typeof event.thinkingLevel === "string" ? event.thinkingLevel : previous?.thinkingLevel,
    contextUsage: usage && typeof usage.contextWindow === "number" ? usage as SubagentInfo["contextUsage"] : previous?.contextUsage,
    revision: seq ?? previous?.revision,
  };
}

/** A snapshot is scoped to one conversation, not a replacement for the global
 * registry. Its per-run revision also prevents an old reply undoing a live push. */
export function mergeSubagentSnapshot(current: SubagentInfo[], snapshot: SubagentInfo[]): SubagentInfo[] {
  const next = new Map(current.map((item) => [item.id, item]));
  let changed = false;
  for (const item of snapshot) {
    const before = next.get(item.id);
    if (before && (before.revision ?? 0) >= (item.revision ?? 0)) continue;
    next.set(item.id, { ...before, ...item });
    changed = true;
  }
  return changed ? [...next.values()] : current;
}

/** Persisted tool details preserve each sibling's outcome after a window/app
 * restart, when the in-memory run registry is no longer available. */
export function subagentResultStatus(tool: ToolCallBlock, index: number): string {
  const details = record(tool.details);
  const results = Array.isArray(details?.results) ? details.results : [];
  const result = record(results[index]);
  if (result && result.exitCode !== -1) {
    if (result.stopReason === "aborted") return "aborted";
    if (result.stopReason === "error" || (typeof result.exitCode === "number" && result.exitCode !== 0)) return "error";
    return "completed";
  }
  if (tool.status === "running") return "queued";
  return result ? "unknown" : "skipped";
}

/** The tab is only a boot-time fallback, never a second live status source. */
export function subagentViewStatus(info: SubagentInfo | undefined, fallback?: string): string {
  return info?.status ?? fallback ?? "unknown";
}
