export const AGENT_THREAD_STATUSES = ["queued", "working", "waiting", "completed", "failed", "interrupted", "closed"] as const;
export type AgentThreadStatus = (typeof AGENT_THREAD_STATUSES)[number];
export const AGENT_MESSAGE_KINDS = ["task", "message", "result"] as const;
export type AgentMessageKind = (typeof AGENT_MESSAGE_KINDS)[number];

export type AgentThread = {
  id: string;
  conversationId: string;
  parentId?: string;
  taskName?: string;
  rootId: string;
  /** Configured role name; `name` is the per-thread display identity. */
  agent?: string;
  name?: string;
  avatarSeed?: number;
  task: string;
  cwd: string;
  systemPrompt?: string;
  tools?: string[];
  fallbackModel?: string;
  model?: { provider: string; id: string };
  thinkingLevel?: string;
  status: AgentThreadStatus;
  phase?: "working" | "waiting" | "retrying" | "compacting";
  createdAt: number;
  updatedAt: number;
  startedAt?: number;
  endedAt?: number;
  currentTurn?: number;
  lastMessage?: string;
  unread?: boolean;
  revision: number;
};

export type AgentThreadMessage = {
  id: string;
  threadId: string;
  senderId: string;
  recipientId?: string;
  kind: AgentMessageKind;
  text: string;
  turn?: number;
  createdAt: number;
  deliveredAt?: number;
};

export function agentThreadFinished(status: AgentThreadStatus): boolean {
  return status === "completed" || status === "failed" || status === "interrupted" || status === "closed";
}
