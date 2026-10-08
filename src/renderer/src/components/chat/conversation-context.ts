import { createContext, useContext } from "react";

/** The transcript's owner, including side chats. Never infer it from a tool or the foreground chat. */
export const TranscriptConversationContext = createContext<string | null>(null);
export const useTranscriptConversation = (): string | null => useContext(TranscriptConversationContext);
