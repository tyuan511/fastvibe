import type { ChatMessage, SubagentInfo } from "../../../shared/types.ts";
import { agentThreadIdForRun, subagentToolRuns } from "../../../shared/subagent-state.ts";
import type { AgentThread } from "../../../shared/agent-thread.ts";
import { familyOf } from "./tool-family.ts";

export type ResourceAgent = {
  id: string;
  name: string;
  brief?: string;
  status: string;
  info?: SubagentInfo;
  parentId?: string;
  avatarSeed?: number;
};

/** Agents that belong to one conversation, with live state overriding transcript fallback. */
export function conversationAgents(conversationId: string, messages: readonly ChatMessage[], registry: readonly SubagentInfo[], threads: readonly AgentThread[] = []): ResourceAgent[] {
  const runs = new Map<string, ResourceAgent>();
  for (const message of messages) for (const tool of message.tools) {
    if (familyOf(tool.name) !== "agent") continue;
    for (const entry of subagentToolRuns(tool)) {
      runs.set(entry.id, { id: entry.id, name: entry.name, brief: entry.task, status: entry.status, avatarSeed: entry.avatarSeed, parentId: entry.parentId });
    }
  }
  for (const thread of threads) {
    if (thread.conversationId !== conversationId) continue;
    runs.set(thread.id, { id: thread.id, name: thread.name ?? thread.agent ?? thread.id, brief: thread.task, status: thread.status === "working" || thread.status === "queued" ? "running" : thread.status, parentId: thread.parentId, avatarSeed: thread.avatarSeed });
  }
  const latest = new Map<string, SubagentInfo>();
  for (const info of registry) {
    if (info.conversationId !== conversationId) continue;
    const id = agentThreadIdForRun(info.id);
    const previous = latest.get(id);
    const turn = (value: SubagentInfo): number => Number(/:turn:(\d+)$/.exec(value.id)?.[1] ?? 0);
    if (!previous || turn(info) > turn(previous)) latest.set(id, info);
  }
  for (const [id, info] of latest) {
    const previous = runs.get(id);
    // Persisted thread status survives process recovery; a live run overrides
    // the creation result, but must not resurrect a newer thread snapshot.
    const thread = threads.find((item) => item.id === id && item.conversationId === conversationId);
    const runTurn = Number(/:turn:(\d+)$/.exec(info.id)?.[1] ?? 0);
    const status = thread && (thread.currentTurn ?? 1) >= runTurn && ["completed", "failed", "interrupted", "closed"].includes(thread.status)
      ? thread.status : info.status ?? previous?.status ?? "unknown";
    const displayInfo = status === info.status ? info : { ...info, status, phase: undefined };
    runs.set(id, { ...previous, id, name: info.name ?? previous?.name ?? info.agent ?? id, brief: info.detail ?? previous?.brief, status, info: displayInfo, avatarSeed: info.avatarSeed ?? previous?.avatarSeed });
  }
  return [...runs.values()].sort((a, b) => resourceAgentPriority(a) - resourceAgentPriority(b));
}

export function resourceAgentFinished(agent: ResourceAgent): boolean {
  return ["completed", "aborted", "cancelled", "skipped", "interrupted", "closed"].includes(agent.status);
}

function resourceAgentPriority(agent: ResourceAgent): number {
  if (agent.info?.phase === "waiting" || ["error", "failed", "blocked"].includes(agent.status)) return 0;
  if (agent.status === "running") return 1;
  return resourceAgentFinished(agent) ? 3 : 2;
}
