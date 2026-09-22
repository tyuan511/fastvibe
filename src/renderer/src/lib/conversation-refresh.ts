import type { ChatMessage, EngineSessionState, SessionStats } from "../../../shared/types.ts";

interface RefreshEngine {
  getStats(id: string): Promise<SessionStats>;
  getState(id: string): Promise<EngineSessionState>;
  getMessages(id: string): Promise<ChatMessage[]>;
}

interface RefreshStore {
  activeId: string | null;
  setStats(stats: SessionStats): void;
  setSession(state: EngineSessionState): void;
  setMessages(messages: ChatMessage[], id: string): void;
}

export function createConversationRefresh(engine: RefreshEngine, getStore: () => RefreshStore) {
  async function refresh<T>(
    read: (id: string) => Promise<T>,
    apply: (store: RefreshStore, value: T, id: string) => void,
  ): Promise<void> {
    try {
      const id = getStore().activeId;
      if (!id) return;
      const value = await read(id);
      const store = getStore();
      if (store.activeId === id) apply(store, value, id);
    } catch {
      // Background refreshes are best-effort.
    }
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
    reloadActiveMessages: (): Promise<void> => refresh(
      (id) => engine.getMessages(id),
      (store, messages, id) => store.setMessages(messages, id),
    ),
  };
}
