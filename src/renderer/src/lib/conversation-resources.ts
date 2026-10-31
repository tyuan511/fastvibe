import type { ChatMessage, SubagentInfo } from "../../../shared/types.ts";
import { subagentEntries, subagentResultStatus } from "../../../shared/subagent-state.ts";
import { familyOf } from "./tool-family.ts";

export type ResourceAgent = {
  id: string;
  name: string;
  brief?: string;
  status: string;
  info?: SubagentInfo;
  parentId?: string;
};

/** Agents that belong to one conversation, with live state overriding transcript fallback. */
export function conversationAgents(conversationId: string, messages: readonly ChatMessage[], registry: readonly SubagentInfo[]): ResourceAgent[] {
  const runs = new Map<string, ResourceAgent>();
  for (const message of messages) for (const tool of message.tools) {
    if (familyOf(tool.name) !== "agent") continue;
    subagentEntries(tool.args).forEach((entry, index) => {
      const id = tool.id + ":" + index;
      runs.set(id, { id, name: entry.agent, brief: entry.task, status: subagentResultStatus(tool, index) });
    });
  }
  for (const info of registry) {
    if (info.conversationId !== conversationId) continue;
    const previous = runs.get(info.id);
    runs.set(info.id, { id: info.id, name: info.name ?? info.agent ?? previous?.name ?? info.id, brief: info.detail ?? previous?.brief, status: info.status ?? "unknown", info });
  }
  return [...runs.values()].sort((a, b) => resourceAgentPriority(a) - resourceAgentPriority(b));
}

export function resourceAgentFinished(agent: ResourceAgent): boolean {
  return ["completed", "aborted", "cancelled", "skipped"].includes(agent.status);
}

function resourceAgentPriority(agent: ResourceAgent): number {
  if (agent.info?.phase === "waiting" || ["error", "failed", "blocked"].includes(agent.status)) return 0;
  if (agent.status === "running") return 1;
  return resourceAgentFinished(agent) ? 3 : 2;
}
