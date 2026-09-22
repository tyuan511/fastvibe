import type { ChatMessage, EngineSessionState, SessionStats, TranscriptTail } from "../../../shared/types.ts";

interface RefreshEngine {
  getStats(id: string): Promise<SessionStats>;
  getState(id: string): Promise<EngineSessionState>;
  getMessages(id: string): Promise<ChatMessage[]>;
  getMessagesSince(anchorId: string, id: string): Promise<TranscriptTail>;
}

interface RefreshStore {
  activeId: string | null;
  messages: ChatMessage[];
  setStats(stats: SessionStats): void;
  setSession(state: EngineSessionState): void;
  setMessages(messages: ChatMessage[], id: string): void;
  spliceMessages(anchorId: string, tail: ChatMessage[], id: string): boolean;
}

/**
 * The row an end-of-turn read can start from: the prompt of the turn that just ran.
 *
 * A `ChatMessage.id` *is* its session-entry id, so Main can find it on the branch and
 * map only from there. Everything a finished turn changes — its replies, their tool
 * results, a compaction summary, the model divider on the first reply — lies at or
 * after that prompt, and the rows above it are already what the read would say.
 *
 * The optimistic row a send puts up (`local:`) has no entry yet, so it is skipped: the
 * anchor falls back to the previous turn's prompt, which costs one extra turn to map
 * and stays correct. No prompt at all (an imported or system-only transcript) means a
 * full read.
 */
export function reloadAnchor(messages: ChatMessage[]): string | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role !== "user" || message.id.startsWith("local:")) continue;
    return message.id;
  }
  return undefined;
}

/**
 * Conversation-scoped transcript/state refreshes.
 *
 * Every read carries the id of the conversation it is about. Calling the raw bridge
 * without one asks Main for *its* active chat, which over remote access is a different
 * machine's — that is what used to overwrite a remote transcript with the local one on
 * every finished turn. The reply is checked against the id again before it is applied,
 * because a read travels one hop and the user may have switched in the meantime.
 */
export function createConversationRefresh(engine: RefreshEngine, getStore: () => RefreshStore) {
  async function refresh<T>(
    read: (id: string, store: RefreshStore) => Promise<T>,
    apply: (store: RefreshStore, value: T, id: string) => void,
  ): Promise<void> {
    try {
      const store = getStore();
      const id = store.activeId;
      if (!id) return;
      const value = await read(id, store);
      const current = getStore();
      if (current.activeId === id) apply(current, value, id);
    } catch {
      // Background refreshes are best-effort.
    }
  }

  async function readTail(id: string, anchor: string): Promise<TranscriptTail> {
    const reply = await engine.getMessagesSince(anchor, id);
    if (reply.mode === "tail") return reply;
    return { mode: "full", messages: await engine.getMessages(id) };
  }

  return {
    refreshStats: (): Promise<void> => refresh(
      (id) => engine.getStats(id),
      (store, stats) => store.setStats(stats),
    ),
    reloadActiveState: (): Promise<void> => refresh(
      (id) => engine.getState(id),
      (store, state, id) => {
        if (state.conversationId === id) store.setSession(state);
      },
    ),
    /**
     * Re-read the transcript of the conversation on screen.
     *
     * With a prompt to anchor on only the tail is read; a full read is the fallback when
     * there is none, when Main says the anchor is gone (an edit, retry or fork rewound
     * past it), or when the store refuses the splice because the rows moved under it.
     */
    reloadActiveMessages: (): Promise<void> => refresh(
      async (id, store) => {
        const anchor = reloadAnchor(store.messages);
        return anchor ? await readTail(id, anchor) : { mode: "full" as const, messages: await engine.getMessages(id) };
      },
      (store, reply, id) => {
        if (reply.mode === "full") {
          store.setMessages(reply.messages, id);
          return;
        }
        if (store.spliceMessages(reply.anchorId, reply.messages, id)) return;
        void engine.getMessages(id).then((messages) => {
          const current = getStore();
          if (current.activeId === id) current.setMessages(messages, id);
        }).catch(() => undefined);
      },
    ),
  };
}
