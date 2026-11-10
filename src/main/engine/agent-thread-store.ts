import { agentIdentityForId } from "../../shared/agent-identity.ts";
import type { AgentMessageKind, AgentThread, AgentThreadMessage, AgentThreadStatus } from "../../shared/agent-thread.ts";
import type { Db } from "./db.ts";
import type { ReviewReport } from "../../shared/review.ts";

/** Sidebar snippet only; the full turn output stays in the result mailbox message. */
const LAST_MESSAGE_CHARS = 2000;

export class AgentThreadStore {
  #db: Db;
  constructor(db: Db) { this.#db = db; }

  #normalize(thread: AgentThread): AgentThread {
    if (typeof thread.avatarSeed === "number" && thread.name && thread.name !== thread.agent) return thread;
    const identity = agentIdentityForId(thread.id);
    const next = { ...thread, name: identity.name, avatarSeed: identity.avatarSeed };
    this.#db.run("UPDATE agent_threads SET data = ? WHERE id = ?", JSON.stringify(next), thread.id);
    return next;
  }

  create(input: Omit<AgentThread, "rootId" | "revision" | "createdAt" | "updatedAt"> & { id: string; createdAt?: number }): AgentThread {
    const now = input.createdAt ?? Date.now();
    const rootId = input.parentId ? this.get(input.parentId)?.rootId ?? input.parentId : input.id;
    const identity = input.avatarSeed === undefined || !input.name ? agentIdentityForId(input.id) : { name: input.name, avatarSeed: input.avatarSeed };
    const thread: AgentThread = { ...input, name: identity.name, avatarSeed: identity.avatarSeed, rootId, createdAt: now, updatedAt: now, revision: 1 };
    this.#db.run("INSERT INTO agent_threads (id, conversation_id, parent_id, root_id, status, updated_at, data) VALUES (?, ?, ?, ?, ?, ?, ?)", thread.id, thread.conversationId, thread.parentId, thread.rootId, thread.status, now, JSON.stringify(thread));
    return thread;
  }

  get(id: string): AgentThread | undefined {
    const row = this.#db.get<{ data?: string }>("SELECT data FROM agent_threads WHERE id = ?", id);
    return row?.data ? this.#normalize(JSON.parse(row.data) as AgentThread) : undefined;
  }

  list(conversationId?: string): AgentThread[] {
    const rows = conversationId
      ? this.#db.all<{ data: string }>("SELECT data FROM agent_threads WHERE conversation_id = ? ORDER BY updated_at DESC, id", conversationId)
      : this.#db.all<{ data: string }>("SELECT data FROM agent_threads ORDER BY updated_at DESC, id");
    return rows.map((row) => this.#normalize(JSON.parse(row.data) as AgentThread));
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

  /** Commit the outcome and its parent mailbox message together, once per thread turn. */
  finishTurn(id: string, turn: number, status: "completed" | "failed" | "interrupted", output: string, error?: string, reviewReport?: ReviewReport): AgentThread | undefined {
    return this.#db.transaction(() => {
      const current = this.get(id);
      if (!current || (current.currentTurn ?? 1) !== turn) return undefined;
      const active = ["queued", "working", "waiting"].includes(current.status);
      if (!active && !(status === "interrupted" && current.status === "interrupted")) return undefined;
      const excerpt = current.review && status === "failed" ? [error, output].filter(Boolean).join("\n\n") : output;
      const next = this.setStatus(id, status, { endedAt: Date.now(), ...(status === "completed" && reviewReport ? { reviewReport } : {}), lastMessage: excerpt.length > LAST_MESSAGE_CHARS ? `${excerpt.slice(0, LAST_MESSAGE_CHARS)}…` : excerpt, unread: true });
      // An interruption retains partial output for follow-up, but sends no parent notification.
      if (status === "interrupted" && !output) return next;
      const message: AgentThreadMessage = {
        id: `${id}:result:${turn}`,
        threadId: id,
        senderId: id,
        recipientId: status === "interrupted" ? undefined : current.conversationId,
        kind: "result",
        ...(status === "completed" && reviewReport ? { reviewReport } : {}),
        text: status === "failed" ? [error || "Agent turn failed.", output].filter(Boolean).join("\n\n") : output || "Agent completed without a text result.",
        turn,
        status: status === "interrupted" ? undefined : status,
        createdAt: Date.now(),
      };
      this.#db.run("INSERT INTO agent_thread_messages (id, thread_id, created_at, data) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO NOTHING", message.id, id, message.createdAt, JSON.stringify(message));
      return next;
    });
  }

  /** Model mailbox, separate from the UI's unread badge. Old unaddressed results stay historical. */
  pendingResults(conversationId: string): AgentThreadMessage[] {
    return this.#db.all<{ data: string }>(`
      SELECT m.data FROM agent_thread_messages m
      JOIN agent_threads t ON t.id = m.thread_id
      WHERE t.conversation_id = ?
        AND json_extract(m.data, '$.recipientId') = ?
        AND json_extract(m.data, '$.kind') = 'result'
        AND json_extract(m.data, '$.deliveredAt') IS NULL
      ORDER BY m.created_at, m.id LIMIT 8
    `, conversationId, conversationId).map((row) => JSON.parse(row.data) as AgentThreadMessage);
  }

  acknowledgeResults(conversationId: string, ids: string[]): void {
    if (ids.length === 0) return;
    this.#db.transaction(() => {
      for (const id of ids) {
        const row = this.#db.get<{ data: string }>(`
          SELECT m.data FROM agent_thread_messages m JOIN agent_threads t ON t.id = m.thread_id
          WHERE m.id = ? AND t.conversation_id = ?
        `, id, conversationId);
        if (!row) continue;
        const message = JSON.parse(row.data) as AgentThreadMessage;
        if (message.recipientId !== conversationId || message.kind !== "result" || message.deliveredAt) continue;
        this.#db.run("UPDATE agent_thread_messages SET data = ? WHERE id = ?", JSON.stringify({ ...message, deliveredAt: Date.now() }), id);
      }
    });
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
