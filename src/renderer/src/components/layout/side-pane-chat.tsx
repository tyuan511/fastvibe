import { useCallback, useEffect, useRef, useState, type JSX } from "react";
import { useTranslation } from "react-i18next";
import { HugeiconsIcon } from "@hugeicons/react";
import { MessageSquareIcon } from "@hugeicons/core-free-icons";
import { useNavigate } from "react-router";
import { Composer } from "@/components/chat/composer";
import { MessageList } from "@/components/chat/message-list";
import { usagePercent } from "@/components/chat/session-controls";
import { useSessionStore } from "@/stores/session";
import { useSettingsStore } from "@/stores/settings";
import { useSidePaneStore, type SidePaneTab } from "@/stores/side-pane";
import { attachmentPromptSuffix, attachmentsToImages } from "@/lib/attachments";
import { randomUUID } from "../../../../shared/random.ts";
import { engine, promptConversation } from "@/lib/engine-client";
import { translate } from "@/lib/i18n";
import { usePermissionModeSelection } from "@/components/permission-mode-provider";
import type { ChatAttachment, ChatMessage } from "@shared/types";
import { parseCompactCommand } from "@shared/slash";
import { isAbortOutcome } from "@shared/abort";

/** Side chats already handed the composer once. Survives the tab unmounting. */
const focusedSideComposers = new Set<string>();

function SideChatEmpty(): JSX.Element {
  const { t } = useTranslation("sidepane");
  return (
    <div className="flex h-full flex-col items-center justify-center px-6 text-center">
      <div className="flex size-10 items-center justify-center rounded-2xl bg-muted text-muted-foreground">
        <HugeiconsIcon strokeWidth={2} icon={MessageSquareIcon} className="size-5" />
      </div>
      <h2 className="mt-3 text-base font-semibold tracking-tight">{t("chat.title")}</h2>
      <p className="mt-1 max-w-[16rem] text-sm leading-5 text-muted-foreground">
        {t("chat.desc")}
      </p>
    </div>
  );
}

export function SidePaneChat({
  tab,
  project,
  parentId,
}: {
  tab: SidePaneTab;
  project?: string;
  parentId?: string;
}): JSX.Element {
  const { t } = useTranslation("sidepane");
  const patchTab = useSidePaneStore((state) => state.patchTab);
  const navigate = useNavigate();
  const models = useSessionStore((state) => state.models);
  const session = useSessionStore((state) => state.session);
  const projects = useSessionStore((state) => state.projects);
  const commands = useSessionStore((state) => state.commands);
  const settings = useSettingsStore((state) => state.settings);
  const { setPermissionMode } = usePermissionModeSelection();
  const [attachments, setAttachments] = useState<ChatAttachment[]>(() => tab.initialAttachments ?? []);
  const [focusSignal, setFocusSignal] = useState(0);
  const initialSent = useRef(false);
  const messages = tab.messages ?? [];
  const streaming = Boolean(tab.streaming);
  // The busy mark for the conversation this tab shows — the same per-conversation map
  // the sidebar draws its spinner from, so the stop button here cannot disagree with
  // the mark next to this chat's title.
  const conversationWorking = useSessionStore((state) =>
    tab.conversationId ? state.running[tab.conversationId] === true : streaming,
  );
  // Derived on demand, not per render: a side chat streams into `tab.messages` at the
  // same cadence as the main thread, and ↑/↓ recall is the only reader.
  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  const history = useCallback(
    () => messagesRef.current.filter((item) => item.role === "user").map((item) => item.text).filter(Boolean),
    [],
  );

  useEffect(() => {
    if (tab.conversationId || !parentId) return;
    let cancelled = false;
    void window.fastvibe.conversations
      .createSide({ parentId, title: tab.title })
      .then((result) => {
        if (cancelled) {
          void window.fastvibe.conversations.delete(result.conversation.id).catch(() => undefined);
          return;
        }
        patchTab(tab.id, { conversationId: result.conversation.id, messages: result.messages });
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [parentId, patchTab, tab.conversationId, tab.id, tab.title]);

  useEffect(() => {
    if (!tab.conversationId || !tab.sendOnCreate || initialSent.current) return;
    initialSent.current = true;
    void send();
  }, [tab.conversationId, tab.sendOnCreate]);

  useEffect(() => {
    if (!tab.focusComposer || !tab.conversationId || focusedSideComposers.has(tab.id)) return;
    // Wait a frame so StrictMode's setup/cleanup pair cancels the first attempt,
    // and so the composer is enabled (it stays disabled until the conversation exists).
    const frame = requestAnimationFrame(() => {
      if (focusedSideComposers.has(tab.id)) return;
      focusedSideComposers.add(tab.id);
      setFocusSignal((value) => value + 1);
    });
    return () => cancelAnimationFrame(frame);
  }, [tab.conversationId, tab.focusComposer, tab.id]);

  async function send(): Promise<void> {
    const text = tab.draft?.trim() ?? "";
    const id = tab.conversationId;
    const items = attachments;
    if ((!text && items.length === 0) || !id || tab.streaming) return;
    if (parseCompactCommand(text)) {
      patchTab(tab.id, { draft: "" });
      try {
        await promptConversation(id, text);
      } catch {
        patchTab(tab.id, { draft: text });
      }
      return;
    }
    const promptText = text || translate("chat:composer.seeAttachments");
    // The selected-text reference is displayed below the message, but the selected
    // question itself is the prompt. Do not append the reference metadata a second
    // time on the first automatic send.
    const initialIds = new Set((tab.sendOnCreate ? tab.initialAttachments : undefined)?.map((item) => item.id));
    const promptAttachments = items.filter((item) => !initialIds.has(item.id));
    const payload = `${promptText}${attachmentPromptSuffix(promptAttachments)}`;
    // The row is optimistic and minted with a `local:` id, exactly like the main
    // thread's: the engine echoes this prompt back as a `message_start`, and without
    // the id the pane appended that echo as a second copy of the same message.
    const user: ChatMessage = {
      id: `local:${randomUUID()}`,
      role: "user",
      text: promptText,
      tools: [],
      parts: [{ kind: "text", text: promptText }],
      createdAt: Date.now(),
      attachments: items.length ? items : undefined,
    };
    // Read the transcript at send time, not from this render: an engine event may
    // have landed in between, and patching with the render's copy would drop it.
    const current = useSidePaneStore.getState().tabs.find((entry) => entry.id === tab.id)?.messages ?? messages;
    // Consume the composer before the await, so a second Enter cannot resend it.
    patchTab(tab.id, { draft: "", messages: [...current, user], streaming: true });
    setAttachments([]);
    try {
      // The attachments go with it: this call used to drop them, so a picture sent
      // here reached the transcript but never the model.
      await promptConversation(id, payload, attachmentsToImages(items));
    } catch (error) {
      // Stop means the optimistic turn did reach the engine. Its stream owns the
      // interrupted transcript; only a real send failure should restore the draft.
      if (isAbortOutcome(error)) return;
      patchTab(tab.id, { draft: text, messages: current, streaming: false });
      setAttachments(items);
    }
  }

  const projectName = projects.find((item) => item.cwd === project)?.name ?? t("chat.noProject");

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1">
        <MessageList
          messages={messages}
          streaming={streaming}
          conversationId={tab.conversationId}
          loading={!tab.conversationId}
          emptyState={<SideChatEmpty />}
        />
      </div>
      <div className="px-3 pb-3">
        <Composer
          className="px-0 pb-0"
          value={tab.draft ?? ""}
          disabled={!tab.conversationId}
          focusSignal={focusSignal || undefined}
          streaming={streaming}
          working={conversationWorking}
          placeholder={t("chat.placeholder")}
          models={models}
          model={session?.model}
          thinkingLevel={session?.thinkingLevel}
          workspaceLabel={projectName}
          projects={projects}
          project={project}
          hideProjectPicker
          commands={commands}
          permissionMode={settings.permissionMode}
          onPermissionModeChange={setPermissionMode}
          queued={[]}
          queuePause={null}
          attachments={attachments}
          history={history}
          contextPercent={usagePercent(session)}
          contextUsage={session?.contextUsage}
          onChange={(value) => {
            patchTab(tab.id, { draft: value });
          }}
          onSubmit={() => {
            void send();
          }}
          onAbort={() => {
            if (tab.conversationId) void engine.abort(tab.conversationId);
          }}
          onPickWorkspace={() => undefined}
          onSelectProject={() => undefined}
          onModelChange={(provider, modelId) => {
            // Addressed to the side chat's own conversation: this pane shows a chat that
            // is not the one on screen, so defaulting to the active id would switch the
            // model of whichever chat the user is looking at instead of this one.
            const id = tab.conversationId;
            if (!id) return;
            void engine.setModel(provider, modelId, id).then((next) => {
              useSessionStore.getState().setSession(next);
            });
          }}
          onManageModels={() => navigate("/settings/providers")}
          onThinkingChange={(level) => {
            const id = tab.conversationId;
            if (!id) return;
            void engine.setThinking(level, id).then((next) => {
              useSessionStore.getState().setSession(next);
            });
          }}
          onAttachmentsChange={setAttachments}
          onRemoveQueued={() => undefined}
          onEditQueued={() => undefined}
          onSendQueuedNow={() => undefined}
          onRecallQueued={() => undefined}
          onReorderQueued={() => undefined}
          onResumeQueue={() => undefined}
          sendOnEnter={settings.sendOnEnter}
        />
      </div>
    </div>
  );
}
