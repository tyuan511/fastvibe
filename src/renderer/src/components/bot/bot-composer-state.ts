import { create } from "zustand";
import type { BotSubmitRequest } from "@shared/bot";
import type { ChatAttachment } from "@shared/types";

/** Device-local draft: opening a task or leaving Vivi never discards typed text or attachments. */
export const useBotComposerState = create<{
  draft: string;
  attachments: ChatAttachment[];
  optimistic: import("@shared/bot").BotChatMessage | null;
  sending: boolean;
  error: string | null;
  request: BotSubmitRequest | null;
  setDraft: (draft: string) => void;
  setAttachments: (attachments: ChatAttachment[]) => void;
}>((set) => ({
  draft: "", attachments: [], optimistic: null, sending: false, error: null, request: null,
  setDraft: (draft) => set({ draft }),
  setAttachments: (attachments) => set({ attachments }),
}));
