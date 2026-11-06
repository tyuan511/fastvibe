import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { BotConversationMeta, WorkSnapshot } from "../../shared/bot.ts";

export type BotAttention = { id: string; conversationId: string; kind: "question" | "failed"; title: string; text: string };

/** Announced fact ids. Durable facts supply identity; UI focus controls when an unread fact is first announced. */
export type BotAttentionState = { version: 1; announced: string[] };

export type BotAttentionStateStore = {
  load(): BotAttentionState | undefined;
  save(state: BotAttentionState): void;
};

/**
 * Announces each pending question and failed/blocked/uncertain result at most once — the
 * announced set persists across restarts, so an old unresolved fact does not nag on every
 * launch. Facts that already exist when the store is first set up count as announced
 * without a notice, instead of reminding about stale ones after the upgrade.
 */
export class BotAttentionNotices {
  #announced = new Set<string>();
  #store: BotAttentionStateStore | undefined;
  #restored = false;
  #savedJson: string | undefined;

  constructor(store?: BotAttentionStateStore) {
    this.#store = store;
  }

  take(snapshot: WorkSnapshot, options: { enabled: boolean; focused: boolean; viewingVivi: boolean }): BotAttention[] {
    const byId = new Map(snapshot.conversations.map((conversation) => [conversation.conversationId, conversation]));
    const candidates: BotAttention[] = [];
    for (const question of snapshot.attention) {
      if (question.status !== "pending") continue;
      const conversation = byId.get(question.conversationId);
      candidates.push({ id: question.id, conversationId: question.conversationId, kind: "question", title: titleOf(conversation), text: question.question });
    }
    for (const result of snapshot.results) {
      if (result.status !== "failed" && result.status !== "blocked" && result.status !== "uncertain") continue;
      const conversation = byId.get(result.conversationId);
      candidates.push({ id: result.id, conversationId: result.conversationId, kind: "failed", title: titleOf(conversation), text: result.summary ?? "" });
    }
    const current = new Set(candidates.map((candidate) => candidate.id));
    this.#restoreOnce(current);
    for (const id of this.#announced) if (!current.has(id)) this.#announced.delete(id);
    if (!options.enabled) {
      this.#persist();
      return [];
    }
    const notices = candidates.filter((candidate) => {
      if (this.#announced.has(candidate.id)) return false;
      if (options.focused && (candidate.kind === "failed" || options.viewingVivi)) return false;
      this.#announced.add(candidate.id);
      return true;
    });
    this.#persist();
    return notices;
  }

  #restoreOnce(current: Set<string>): void {
    if (this.#restored) return;
    this.#restored = true;
    if (!this.#store) return;
    const state = this.#store.load();
    if (!state) {
      for (const id of current) this.#announced.add(id);
      return;
    }
    for (const id of state.announced) if (typeof id === "string") this.#announced.add(id);
  }

  #persist(): void {
    if (!this.#store) return;
    const state: BotAttentionState = { version: 1, announced: [...this.#announced].sort() };
    const json = JSON.stringify(state);
    if (json === this.#savedJson) return;
    this.#savedJson = json;
    this.#store.save(state);
  }
}

/** Small Main-owned state file following the `window-state.json` pattern. */
export function botAttentionStateStore(file: string): BotAttentionStateStore {
  return {
    load(): BotAttentionState | undefined {
      let state: unknown;
      try {
        state = JSON.parse(readFileSync(file, "utf8"));
      } catch {
        return undefined;
      }
      if (!state || typeof state !== "object") return undefined;
      const announced = (state as { announced?: unknown }).announced;
      if (!Array.isArray(announced)) return undefined;
      return { version: 1, announced: announced.filter((id): id is string => typeof id === "string") };
    },
    save(state: BotAttentionState): void {
      mkdirSync(dirname(file), { recursive: true });
      const temp = `${file}.${process.pid}.tmp`;
      writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
      renameSync(temp, file);
    },
  };
}

function titleOf(conversation: BotConversationMeta | undefined): string {
  return conversation?.title || (conversation?.role === "router" ? "Vivi" : "工作会话");
}
