import { useEffect, useMemo, useState, type JSX } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { MessageSquareIcon } from "@hugeicons/core-free-icons";
import { useNavigate } from "react-router";
import { Composer } from "@/components/chat/composer";
import { MessageList } from "@/components/chat/message-list";
import { usagePercent } from "@/components/chat/session-controls";
import { useSessionStore } from "@/stores/session";
import { useSettingsStore } from "@/stores/settings";
import { useSidePaneStore, type SidePaneTab } from "@/stores/side-pane";
import type { ChatAttachment } from "@shared/types";
import { parseCompactCommand } from "@shared/slash";

function SideChatEmpty(): JSX.Element {
  return (
    <div className="flex h-full flex-col items-center justify-center px-6 text-center">
      <div className="flex size-10 items-center justify-center rounded-2xl bg-muted text-muted-foreground">
        <HugeiconsIcon strokeWidth={2} icon={MessageSquareIcon} className="size-5" />
      </div>
      <h2 className="mt-3 text-base font-semibold tracking-tight">辅助对话</h2>
      <p className="mt-1 max-w-[16rem] text-sm leading-5 text-muted-foreground">
        针对当前任务单独提问，回复只留在这里，不会写入主对话。
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
    const text = tab.draft?.trim();
    const id = tab.conversationId;
    if (!text || !id || tab.streaming) return;
    if (parseCompactCommand(text)) {
      patchTab(tab.id, { draft: "" });
      try {
        await window.fastvibe.engine.promptConversation(id, text);
      } catch {
        patchTab(tab.id, { draft: text });
      }
      return;
    }
    const user = {
      id: crypto.randomUUID(),
      role: "user" as const,
      text,
      tools: [],
      createdAt: Date.now(),
      attachments: attachments.length ? attachments : undefined,
    };
    patchTab(tab.id, { draft: "", messages: [...messages, user], streaming: true });
    setAttachments([]);
    try {
      await window.fastvibe.engine.promptConversation(id, text);
    } catch {
      patchTab(tab.id, { draft: text, streaming: false });
    }
  }

  const projectName = projects.find((item) => item.cwd === project)?.name ?? "无项目";

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1">
        <MessageList
          messages={messages}
          streaming={Boolean(tab.streaming)}
          loading={!tab.conversationId}
          emptyState={<SideChatEmpty />}
        />
      </div>
      <div className="px-3 pb-3">
        <Composer
          className="px-0 pb-0"
          value={tab.draft ?? ""}
          disabled={!tab.conversationId}
          streaming={Boolean(tab.streaming)}
          placeholder="随心输入"
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
          onChange={(value) => patchTab(tab.id, { draft: value })}
          onSubmit={() => void send()}
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
          onReorderQueued={() => undefined}
          onResumeQueue={() => undefined}
          sendOnEnter={settings.sendOnEnter}
        />
      </div>
    </div>
  );
}
