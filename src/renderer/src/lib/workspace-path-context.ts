import { createContext, useContext } from "react";
import { useSessionStore } from "@/stores/session";
import { useTranscriptConversation } from "@/components/chat/conversation-context";

/** undefined means no override; null explicitly represents an unknown scoped cwd. */
export const WorkspacePathContext = createContext<string | null | undefined>(undefined);

export function useWorkspacePath(): string | undefined {
  const override = useContext(WorkspacePathContext);
  const conversationId = useTranscriptConversation();
  const catalogCwd = useSessionStore((state) => state.conversations.find((item) => item.id === (conversationId ?? state.activeId))?.cwd);
  return override !== undefined ? override ?? undefined : catalogCwd;
}
