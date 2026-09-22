import { memo, useEffect, useMemo, useState, type JSX } from "react";
import { useTranslation } from "react-i18next";
import { HugeiconsIcon } from "@hugeicons/react";
import { BotIcon } from "@hugeicons/core-free-icons";
import { Composer } from "@/components/chat/composer";
import { MessageList } from "@/components/chat/message-list";
import { usagePercent } from "@/components/chat/session-controls";
import { useSessionStore } from "@/stores/session";
import { useSettingsStore } from "@/stores/settings";
import { abortSubagent, getSubagentMessages, getSubagents } from "@/lib/engine-client";
import { subagentFinished, subagentViewStatus } from "@shared/subagent-state";
import { subagentStatusText } from "@/lib/subagent-status";
import { toast } from "sonner";
import type { ChatMessage } from "@shared/types";
import type { SidePaneTab } from "@/stores/side-pane";

function SubagentEmpty(): JSX.Element {
  const { t } = useTranslation("sidepane");
  return (
    <div className="flex h-full flex-col items-center justify-center px-6 text-center">
      <div className="flex size-10 items-center justify-center rounded-2xl bg-muted text-muted-foreground">
        <HugeiconsIcon strokeWidth={2} icon={BotIcon} className="size-5" />
      </div>
      <h2 className="mt-3 text-base font-semibold tracking-tight">{t("subagent.title")}</h2>
      <p className="mt-1 max-w-[16rem] text-sm leading-5 text-muted-foreground">
        {t("subagent.desc")}
      </p>
    </div>
  );
}

/**
 * One delegated run, in its own right-pane tab. Each run gets a distinct tab
 * (`subagent:<toolCallId>:<index>`), so parallel/chain runs — and runs from
 * different conversations — never share a view.
 *
 * The transcript matches the main thread — same `MessageList`, same follow-the-bottom
 * scroller — with the delegated brief as the opening user message (the sub-session's
 * live stream never includes that user turn) followed by the role's own assistant turns.
 *
 * Below it sits the main thread's composer in its read-only mode: a delegated run is
 * not a conversation the user can steer, but its *state* is worth reading — which model
 * it is on, how full its context window is — and a run that has gone wrong (or is simply
 * too slow) must be stoppable without discarding the parent's answer too. The stop
 * button aborts this run's own session, which settles the parent's tool call; it is
 * that failed tool result the main agent reads as 「已被用户终止」.
 *
 * The tab pins the brief, the keyed stream carries the transcript, and the shared
 * run registry owns status/model/context. An absent registry row is not a terminal
 * verdict: only an explicit final status may switch from the live stream to cache.
 */
export const SidePaneSubagent = memo(function SidePaneSubagent({ tab }: { tab: SidePaneTab }): JSX.Element {
  const { t } = useTranslation("sidepane");
  const subagentId = tab.subagentId ?? null;
  const active = useSessionStore((state) =>
    subagentId ? state.subagents.find((item) => item.id === subagentId) : undefined,
  );
  const streamed = useSessionStore((state) => (subagentId ? state.subagentStreams[subagentId] : undefined));
  const models = useSessionStore((state) => state.models);
  const showThinking = useSettingsStore((state) => state.settings.showThinking);
  const showTimestamp = useSettingsStore((state) => state.settings.showTimestamps);
  const collapseRuns = useSettingsStore((state) => state.settings.collapseRuns);
  const permissionMode = useSettingsStore((state) => state.settings.permissionMode);
  const [loaded, setLoaded] = useState<ChatMessage[] | null>(null);

  const task = (tab.subagentBrief ?? active?.detail ?? "").trim();
  // `tab.openedAt` keeps the value defined, so the brief's identity never changes
  // when the engine's snapshot finally carries the run's real `startedAt`.
  const startedAt = active?.startedAt ?? tab.openedAt;
  const status = subagentViewStatus(active, tab.subagentStatus);
  const running = status === "running";
  const finished = subagentFinished(status);

  useEffect(() => {
    setLoaded(null);
    void getSubagents(tab.conversationId).then(useSessionStore.getState().setSubagents).catch(() => undefined);
  }, [subagentId, tab.conversationId]);

  // Pull the cached transcript exactly once, when the run is over. Reading it while
  // the run was live mixed a mid-flight snapshot into the growing stream and swapped
  // the whole list — the pane flickered, and the authoritative mapping is only
  // written at the end anyway.
  useEffect(() => {
    if (!subagentId || !finished) return;
    let cancelled = false;
    void getSubagentMessages(subagentId, tab.conversationId)
      .then((result) => {
        if (!cancelled && result.length > 0) setLoaded(result);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [subagentId, finished, tab.conversationId]);

  const brief = useMemo<ChatMessage | null>(() => {
    if (!task) return null;
    return {
      id: `${subagentId ?? tab.id}:brief`,
      role: "user",
      text: task,
      tools: [],
      parts: [{ kind: "text", text: task }],
      createdAt: startedAt,
    };
  }, [startedAt, subagentId, tab.id, task]);

  const body = (finished ? loaded ?? streamed : streamed) ?? [];
  const messages = useMemo(() => {
    // The cached transcript repeats the delegated turn the engine stored; the brief
    // already stands for it.
    if (body.some((item) => item.role === "user")) return body;
    return brief ? [brief, ...body] : body;
  }, [body, brief]);

  const noop = (): void => undefined;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1">
        {messages.length === 0 ? (
          <SubagentEmpty />
        ) : (
          <MessageList
            messages={messages}
            streaming={running}
            showThinking={showThinking}
            showTimestamp={showTimestamp}
            // A delegated run is an agent run too, and its transcript is read the same
            // way — a dozen tool rows around one answer — so 折叠运行过程 applies here.
            collapseRuns={collapseRuns}
          />
        )}
      </div>
      <div className="px-3 pb-3">
        {active?.error ? <p role="status" className={`mb-2 whitespace-pre-wrap text-sm ${status === "error" ? "text-destructive" : "text-muted-foreground"}`}>{active.error}</p> : null}
        <Composer
          readOnly
          className="px-0 pb-0"
          value=""
          disabled
          streaming={running}
          working={running}
          placeholder={t("subagent.readOnlyStatus", { status: subagentStatusText(active, tab.subagentStatus) })}
          models={models}
          model={active?.model}
          thinkingLevel={active?.thinkingLevel}
          workspaceLabel=""
          projects={[]}
          commands={[]}
          permissionMode={permissionMode}
          onPermissionModeChange={noop}
          queued={[]}
          queuePause={null}
          attachments={[]}
          history={() => []}
          contextPercent={usagePercent(active ?? null)}
          contextUsage={active?.contextUsage}
          onChange={noop}
          onSubmit={noop}
          onAbort={() => {
            if (subagentId) void abortSubagent(subagentId, tab.conversationId).catch((error: unknown) => toast.error(String(error)));
          }}
          onPickWorkspace={noop}
          onSelectProject={noop}
          onModelChange={noop}
          onManageModels={noop}
          onThinkingChange={noop}
          onAttachmentsChange={noop}
          onRemoveQueued={noop}
          onEditQueued={noop}
          onSendQueuedNow={noop}
          onRecallQueued={noop}
          onReorderQueued={noop}
          onResumeQueue={noop}
        />
      </div>
    </div>
  );
}, (prev, next) =>
  prev.tab.id === next.tab.id &&
  prev.tab.subagentId === next.tab.subagentId &&
  // The brief arrives with a later `registerSubagent` when the tool card is what
  // opened the tab, and it is what the pane draws as the run's opening message.
  prev.tab.subagentBrief === next.tab.subagentBrief &&
  prev.tab.openedAt === next.tab.openedAt &&
  prev.tab.conversationId === next.tab.conversationId &&
  prev.tab.subagentStatus === next.tab.subagentStatus,
);
