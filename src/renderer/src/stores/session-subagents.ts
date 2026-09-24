import { reduceSubagent } from "@shared/subagent-state";
import type { ChatMessage, EngineEvent, SubagentInfo } from "@shared/types";
import { applyEngineEvent } from "@/lib/apply-engine-event";
import { useSidePaneStore, type SidePaneTab } from "@/stores/side-pane";

export function upsertSubagent(list: SubagentInfo[], event: EngineEvent): SubagentInfo[] {
  const previous = list.find((item) => item.id === event.subagentId);
  const next = reduceSubagent(previous, event);
  if (!next || next === previous) return list;
  return previous ? list.map((item) => item === previous ? next : item) : [next, ...list];
}

/** Maximum number of finished, unwatched delegated transcripts kept in memory. */
const MAX_SUBAGENT_STREAMS = 12;

function watchedSubagentIds(): Set<string> {
  const pane = useSidePaneStore.getState();
  const watched = new Set<string>();
  const collect = (tabs: SidePaneTab[]): void => {
    for (const tab of tabs) if (tab.subagentId) watched.add(tab.subagentId);
  };
  collect(pane.tabs);
  for (const scope of Object.values(pane.scopes)) collect(scope.tabs);
  return watched;
}

function pruneSubagentStreams(
  streams: Record<string, ChatMessage[]>,
  keep: string,
  subagents: SubagentInfo[],
): Record<string, ChatMessage[]> {
  const keys = Object.keys(streams);
  if (keys.length <= MAX_SUBAGENT_STREAMS) return streams;
  const running = new Set(subagents.filter((item) => item.status === "running").map((item) => item.id));
  const watched = watchedSubagentIds();
  const dropped = new Set<string>();
  let over = keys.length - MAX_SUBAGENT_STREAMS;
  for (const key of keys) {
    if (over === 0) break;
    if (key === keep || running.has(key) || watched.has(key)) continue;
    dropped.add(key);
    over -= 1;
  }
  if (dropped.size === 0) return streams;
  const next: Record<string, ChatMessage[]> = {};
  for (const key of keys) if (!dropped.has(key)) next[key] = streams[key];
  return next;
}

export function applySubagentStream(
  streams: Record<string, ChatMessage[]>,
  event: EngineEvent,
  subagents: SubagentInfo[],
): Record<string, ChatMessage[]> {
  if (event.type !== "subagent_event") return streams;
  const id =
    typeof event.subagentId === "string"
      ? event.subagentId
      : typeof event.id === "string"
        ? event.id
        : "";
  if (!id) return streams;
  const nested =
    event.event && typeof event.event === "object"
      ? (event.event as EngineEvent)
      : event.payload && typeof event.payload === "object"
        ? (event.payload as EngineEvent)
        : event;
  if (typeof nested.type !== "string" || nested.type === "subagent_event") return streams;
  if (nested.type === "message_start") {
    const message = nested.message;
    if (message && typeof message === "object" && (message as { role?: unknown }).role === "user") return streams;
  }
  const known = streams[id];
  const applied = applyEngineEvent(known ?? [], nested, true);
  const next: Record<string, ChatMessage[]> = {};
  for (const key of Object.keys(streams)) if (key !== id) next[key] = streams[key];
  next[id] = applied.messages;
  return known === undefined ? pruneSubagentStreams(next, id, subagents) : next;
}
