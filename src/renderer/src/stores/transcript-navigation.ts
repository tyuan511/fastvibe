import { create } from "zustand";

/** Shared by history search and the conversation's output-file list. */
export const useTranscriptNavigation = create<{
  target: { conversationId: string; entryId: string; nonce: number } | null;
  jump: (conversationId: string, entryId: string) => void;
}>((set) => ({
  target: null,
  jump: (conversationId, entryId) => set((state) => ({ target: { conversationId, entryId, nonce: (state.target?.nonce ?? 0) + 1 } })),
}));
