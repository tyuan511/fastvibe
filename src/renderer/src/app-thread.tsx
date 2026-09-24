import { memo, useCallback, type JSX } from "react";
import { MessageList } from "@/components/chat/message-list";
import { pastedTextAttachmentName } from "@/lib/attachments";
import { getModels } from "@/lib/engine-client";
import { useDraftPersistence } from "@/lib/draft-persistence";
import { useSessionStore } from "@/stores/session";
import { useSettingsStore } from "@/stores/settings";
import { useSidePaneStore } from "@/stores/side-pane";
import type { ChatAttachment, ChatMessage, FastVibeModel } from "@shared/types";

/**
 * The models this install can actually chat with.
 *
 * The store holds the list the engine reported once ready and after every 供应商 edit,
 * so a send normally costs nothing; an empty list is re-checked against the engine,
 * because "no models" is the one condition that has to stop a prompt before a
 * conversation is created only for it to fail.
 */
export async function availableModels(): Promise<FastVibeModel[]> {
  const cached = useSessionStore.getState().models;
  if (cached.length > 0) return cached;
  const next = await getModels().catch((): FastVibeModel[] => []);
  useSessionStore.getState().setModels(next);
  return next;
}

/** Selected transcript text, as the pasted-text chip 添加到对话 drops into the composer. */
function selectionAttachment(text: string): ChatAttachment {
  return {
    id: crypto.randomUUID(),
    kind: "file",
    name: pastedTextAttachmentName(text),
    mimeType: "text/plain",
    text,
  };
}

/**
 * Subscribes to the transcript itself so a streamed token re-renders only the
 * message list — not the whole shell (sidebar, composer, side pane). App used to
 * read `messages` directly, which re-rendered the entire tree on every token.
 */
export const MessageThread = memo(function MessageThread({
  loading,
  loadingReplaces = false,
  onRetry,
  onEdit,
  onFork,
}: {
  loading: boolean;
  /** Show the loader in place of whatever transcript is already on screen. */
  loadingReplaces?: boolean;
  onRetry: (message: ChatMessage) => void;
  onEdit: (message: ChatMessage, text: string) => void;
  onFork: (entryId: string) => void;
}): JSX.Element {
  const messages = useSessionStore((state) => state.messages);
  const streaming = useSessionStore((state) => state.streaming);
  const activeId = useSessionStore((state) => state.activeId);
  const addSelectionToConversation = useCallback((text: string) => {
    const store = useSessionStore.getState();
    store.setComposer(store.draft, [...store.attachments, selectionAttachment(text)]);
  }, []);
  const askSelectionInSideChat = useCallback((text: string) => {
    if (!activeId) return;
    const sidePane = useSidePaneStore.getState();
    // Same chip as 添加到对话, and not a prompt: the side chat opens with the
    // selection sitting in its composer so the user can write the question.
    sidePane.openSideChat(
      activeId,
      sidePane.nextSideChatOrdinal(activeId),
      "",
      false,
      [selectionAttachment(text)],
    );
  }, [activeId]);
  return (
    <MessageList
      messages={messages}
      streaming={streaming}
      conversationId={activeId}
      loading={loading}
      loadingReplaces={loadingReplaces}
      onRetry={onRetry}
      onEdit={onEdit}
      onFork={onFork}
      onAddSelectionToConversation={activeId ? addSelectionToConversation : undefined}
      onAskSelectionInSideChat={activeId ? askSelectionInSideChat : undefined}
    />
  );
});

/**
 * The composer's own subscription to what is being typed.
 *
 * `draft` and `attachments` change on every keystroke, and `App` is the shell: the
 * sidebar, the transcript, the side pane and every dialog are built in its render, so
 * reading them there re-rendered all of it per character — a cost that grows with the
 * number of conversations in the sidebar and the number of rows mounted in the thread.
 * The composer's element is built by `render` instead, so a keystroke re-renders this
 * and the composer alone. The same trick `MessageThread` uses for the transcript.
 */
export function ComposerSlot({
  render,
}: {
  render: (draft: string, attachments: ChatAttachment[]) => JSX.Element;
}): JSX.Element {
  const draft = useSessionStore((state) => state.draft);
  const attachments = useSessionStore((state) => state.attachments);
  return render(draft, attachments);
}

/**
 * Draft persistence, kept out of the shell for the same reason — and out of the
 * composer's own slot, which an extension prompt takes over while a question is
 * parked, so the debounce is not torn down and re-armed by an approval.
 */
export function DraftKeeper(): null {
  const activeId = useSessionStore((state) => state.activeId);
  const draft = useSessionStore((state) => state.draft);
  const attachments = useSessionStore((state) => state.attachments);
  const model = useSessionStore((state) => state.session?.model);
  const thinkingLevel = useSessionStore((state) => state.session?.thinkingLevel);
  const permissionMode = useSettingsStore((state) => state.settings.permissionMode);
  const emptySession = useSessionStore((state) => {
    const conversation = state.conversations.find((item) => item.id === state.activeId);
    return Boolean(conversation && !conversation.preview);
  });
  useDraftPersistence(activeId, draft, attachments, model, thinkingLevel, permissionMode, emptySession);
  return null;
}

/** Apply the catalog's project-order semantics without mutating the snapshot array. */
export function orderProjectsByCwd<T extends { cwd: string }>(projects: T[], cwds: string[]): T[] {
  const rank = new Map(cwds.map((cwd, index) => [cwd, index]));
  return [...projects].sort((a, b) => {
    const left = rank.get(a.cwd);
    const right = rank.get(b.cwd);
    if (left === undefined && right === undefined) return 0;
    if (left === undefined) return 1;
    if (right === undefined) return -1;
    return left - right;
  });
}
