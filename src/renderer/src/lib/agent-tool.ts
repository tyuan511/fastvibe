import type { ChatMessage, SubagentInfo, ToolCallBlock } from "../../../shared/types.ts";
import { agentThreadIdForRun, subagentToolRuns } from "../../../shared/subagent-state.ts";

const ACTIONS = {
  spawn_agent: "spawn",
  wait_agent: "wait",
  send_message: "send",
  followup_task: "followup",
  interrupt_agent: "interrupt",
  list_agents: "list",
} as const;

export function agentToolAction(name: string): typeof ACTIONS[keyof typeof ACTIONS] | undefined {
  return ACTIONS[name as keyof typeof ACTIONS];
}

export type AgentToolIdentity = { id: string; name?: string; avatarSeed?: number };
const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

/** Resolve identity from the call's persisted result, preceding creations and the
 * conversation's live registry. No per-row fetch, and no other chat's identity. */
export function agentToolTargets(
  tool: ToolCallBlock,
  conversationId: string | null | undefined,
  messages: readonly ChatMessage[],
  registry: readonly SubagentInfo[],
): AgentToolIdentity[] {
  if (tool.name === "spawn_agent") return subagentToolRuns(tool);
  const identities = new Map<string, AgentToolIdentity>();
  history: for (const message of messages) for (const call of message.tools) {
    if (call.id === tool.id) break history;
    if (call.name === "spawn_agent") for (const entry of subagentToolRuns(call)) identities.set(entry.id, entry);
  }
  const details = record(tool.details);
  const resultThreads = Array.isArray(details?.threads) ? details.threads : undefined;
  const add = (value: unknown): void => {
    const item = record(value);
    if (typeof item?.id !== "string") return;
    if (typeof item.conversationId === "string" && item.conversationId !== conversationId) return;
    const previous = identities.get(item.id);
    identities.set(item.id, {
      id: item.id,
      name: typeof item.name === "string" ? item.name : previous?.name,
      avatarSeed: typeof item.avatarSeed === "number" ? item.avatarSeed : previous?.avatarSeed,
    });
  };
  resultThreads?.forEach(add);
  add(details?.result);
  const knownIds = [...identities.keys()];
  for (const info of registry) {
    if (info.conversationId !== (conversationId ?? undefined) || !info.id.startsWith("agent-")) continue;
    add({ ...info, id: agentThreadIdForRun(info.id) });
  }
  const args = record(tool.args);
  const ids = typeof args?.target === "string" ? [args.target]
    : Array.isArray(args?.targets) ? args.targets.filter((id): id is string => typeof id === "string")
    : resultThreads ? resultThreads.flatMap((item) => {
      const row = record(item);
      return typeof row?.id === "string" && (row.conversationId === undefined || row.conversationId === conversationId) ? [row.id] : [];
    }) : tool.status === "running" ? [...identities.keys()] : knownIds;
  return [...new Set(ids)].map((id) => identities.get(id) ?? { id });
}
