import type { AgentMessageKind, AgentThread, AgentThreadMessage, AgentThreadStatus } from "../../shared/agent-thread.ts";
import type { Db } from "./db.ts";

export class AgentThreadStore {
  #db: Db;
  constructor(db: Db) { this.#db = db; }

  create(input: Omit<AgentThread, "rootId" | "revision" | "createdAt" | "updatedAt"> & { id: string; createdAt?: number }): AgentThread {
    const now = input.createdAt ?? Date.now();
    const rootId = input.parentId ? this.get(input.parentId)?.rootId ?? input.parentId : input.id;
    const thread: AgentThread = { ...input, rootId, createdAt: now, updatedAt: now, revision: 1 };
    this.#db.run("INSERT INTO agent_threads (id, conversation_id, parent_id, root_id, status, updated_at, data) VALUES (?, ?, ?, ?, ?, ?, ?)", thread.id, thread.conversationId, thread.parentId, thread.rootId, thread.status, now, JSON.stringify(thread));
    return thread;
  }

  get(id: string): AgentThread | undefined {
    const row = this.#db.get<{ data?: string }>("SELECT data FROM agent_threads WHERE id = ?", id);
    return row?.data ? JSON.parse(row.data) as AgentThread : undefined;
  }

  list(conversationId?: string): AgentThread[] {
    const rows = conversationId
      ? this.#db.all<{ data: string }>("SELECT data FROM agent_threads WHERE conversation_id = ? ORDER BY updated_at DESC, id", conversationId)
      : this.#db.all<{ data: string }>("SELECT data FROM agent_threads ORDER BY updated_at DESC, id");
    return rows.map((row) => JSON.parse(row.data) as AgentThread);
  }

  patch(id: string, patch: Partial<Omit<AgentThread, "id" | "conversationId" | "rootId" | "createdAt">>): AgentThread | undefined {
    const current = this.get(id);
    if (!current) return undefined;
    const next: AgentThread = { ...current, ...patch, updatedAt: Date.now(), revision: current.revision + 1 };
    this.#db.run("UPDATE agent_threads SET parent_id = ?, root_id = ?, status = ?, updated_at = ?, data = ? WHERE id = ?", next.parentId, next.rootId, next.status, next.updatedAt, JSON.stringify(next), id);
    return next;
  }

  setStatus(id: string, status: AgentThreadStatus, patch: Partial<AgentThread> = {}): AgentThread | undefined { return this.patch(id, { ...patch, status }); }

  send(threadId: string, senderId: string, text: string, kind: AgentMessageKind = "message", recipientId?: string): AgentThreadMessage {
    const message: AgentThreadMessage = { id: `${threadId}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`, threadId, senderId, recipientId, kind, text, createdAt: Date.now() };
    this.#db.run("INSERT INTO agent_thread_messages (id, thread_id, created_at, data) VALUES (?, ?, ?, ?)", message.id, message.threadId, message.createdAt, JSON.stringify(message));
    return message;
  }

  messages(threadId: string): AgentThreadMessage[] {
    return this.#db.all<{ data: string }>("SELECT data FROM agent_thread_messages WHERE thread_id = ? ORDER BY created_at, id", threadId).map((row) => JSON.parse(row.data) as AgentThreadMessage);
  }

  removeConversation(conversationId: string): void { this.#db.run("DELETE FROM agent_threads WHERE conversation_id = ?", conversationId); }

  /** A process restart cannot keep an in-memory runner alive; leave its thread resumable. */
  recoverAfterRestart(): AgentThread[] {
    const recovered: AgentThread[] = [];
    for (const thread of this.list()) {
      if (!["queued", "working", "waiting"].includes(thread.status)) continue;
      const next = this.setStatus(thread.id, "interrupted", { endedAt: Date.now(), unread: true });
      if (next) recovered.push(next);
    }
    return recovered;
  }
}
