import { create } from "zustand";
import type { BotSubmitRequest } from "@shared/bot";

/** Device-local draft: opening a task or leaving Vivi never discards typed text. */
export const useBotComposerState = create<{
  draft: string;
  project: string;
  sending: boolean;
  error: string | null;
  request: BotSubmitRequest | null;
  setDraft: (draft: string) => void;
  setProject: (project: string) => void;
}>((set) => ({
  draft: "", project: "", sending: false, error: null, request: null,
  setDraft: (draft) => set({ draft }),
  setProject: (project) => set({ project }),
}));
