import { useEffect, useMemo, useState, type JSX } from "react";
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
import { translate } from "@/lib/i18n";
import type { ChatAttachment, ChatMessage } from "@shared/types";
import { parseCompactCommand } from "@shared/slash";

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
  const updateSettings = useSettingsStore((state) => state.update);
  const [attachments, setAttachments] = useState<ChatAttachment[]>([]);
  const messages = tab.messages ?? [];
  const streaming = Boolean(tab.streaming);
  // The busy mark for the conversation this tab shows — the same per-conversation map
  // the sidebar draws its spinner from, so the stop button here cannot disagree with
  // the mark next to this chat's title.
  const conversationWorking = useSessionStore((state) =>
    tab.conversationId ? state.running[tab.conversationId] === true : streaming,
  );
  const history = useMemo(
    () => messages.filter((item) => item.role === "user").map((item) => item.text).filter(Boolean),
    [messages],
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

  async function send(): Promise<void> {
    const text = tab.draft?.trim() ?? "";
    const id = tab.conversationId;
    const items = attachments;
    if ((!text && items.length === 0) || !id || tab.streaming) return;
    if (parseCompactCommand(text)) {
      patchTab(tab.id, { draft: "" });
      try {
        await window.fastvibe.engine.promptConversation(id, text);
      } catch {
        patchTab(tab.id, { draft: text });
      }
      return;
    }
    const promptText = text || translate("chat:composer.seeAttachments");
    const payload = `${promptText}${attachmentPromptSuffix(items)}`;
    // The row is optimistic and minted with a `local:` id, exactly like the main
    // thread's: the engine echoes this prompt back as a `message_start`, and without
    // the id the pane appended that echo as a second copy of the same message.
    const user: ChatMessage = {
      id: `local:${crypto.randomUUID()}`,
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
      await window.fastvibe.engine.promptConversation(id, payload, attachmentsToImages(items));
    } catch {
      // Nothing reached the engine: drop the phantom row and hand the composer back.
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
          loading={!tab.conversationId}
          // A 辅助对话 is a normal transcript with its own composer, so it follows the
          // same 折叠运行过程 preference as the main thread.
          collapseRuns={settings.collapseRuns}
          emptyState={<SideChatEmpty />}
        />
      </div>
      <div className="px-3 pb-3">
        <Composer
          className="px-0 pb-0"
          value={tab.draft ?? ""}
          disabled={!tab.conversationId}
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
          onPermissionModeChange={(next) => updateSettings({ permissionMode: next })}
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
          onAbort={() => undefined}
          onPickWorkspace={() => undefined}
          onSelectProject={() => undefined}
          onModelChange={(provider, modelId) => {
            void window.fastvibe.engine.setModel(provider, modelId).then((next) => {
              useSessionStore.getState().setSession(next);
            });
          }}
          onManageModels={() => navigate("/settings/providers")}
          onThinkingChange={(level) => {
            void window.fastvibe.engine.setThinking(level).then((next) => {
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
