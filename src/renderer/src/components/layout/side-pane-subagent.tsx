import { memo, useEffect, useMemo, useState, type JSX } from "react";
import { useTranslation } from "react-i18next";
import { HugeiconsIcon } from "@hugeicons/react";
import { BotIcon } from "@hugeicons/core-free-icons";
import { AgentAvatar } from "@/components/agent-avatar";
import { Composer } from "@/components/chat/composer";
import { MessageList } from "@/components/chat/message-list";
import { usagePercent } from "@/components/chat/session-controls";
import { useSessionStore } from "@/stores/session";
import { abortSubagent, getAgentThreadMessages, getAgentThreads, getSubagentMessages, getSubagents, interruptAgent, onEvent } from "@/lib/engine-client";
import { findSubagent, subagentFinished, subagentKey, subagentViewStatus } from "@shared/subagent-state";
import { subagentStatusText } from "@/lib/subagent-status";
import { toast } from "sonner";
import type { AgentThread, AgentThreadMessage } from "@shared/agent-thread";
import type { ChatMessage } from "@shared/types";
import type { SidePaneTab } from "@/stores/side-pane";

function threadMessagesToChat(thread: AgentThread, messages: AgentThreadMessage[]): ChatMessage[] {
  const output: ChatMessage[] = [{ id: `${thread.id}:task`, role: "user", text: thread.task, tools: [], parts: [{ kind: "text", text: thread.task }], createdAt: thread.createdAt }];
  for (const message of messages) if (message.kind === "result" && message.text) output.push({ id: message.id, role: "assistant", text: message.text, tools: [], parts: [{ kind: "text", text: message.text }], createdAt: message.createdAt });
  return output;
}

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
  const conversationId = tab.subagentConversationId ?? tab.conversationId;
  const [thread, setThread] = useState<AgentThread | undefined>();
  const runId = thread ? `${thread.id}:turn:${thread.currentTurn ?? 1}` : subagentId;
  const active = useSessionStore((state) =>
    runId ? findSubagent(state.subagents, runId, conversationId) : undefined,
  );
  const [loaded, setLoaded] = useState<{ runId: string; messages: ChatMessage[] } | null>(null);
  const [threadMessages, setThreadMessages] = useState<AgentThreadMessage[]>([]);
  const streamed = useSessionStore((state) => runId ? state.subagentStreams[subagentKey(runId, conversationId)] : undefined);
  const models = useSessionStore((state) => state.models);

  const task = (thread?.task ?? tab.subagentBrief ?? active?.detail ?? "").trim();
  const startedAt = thread?.startedAt ?? active?.startedAt ?? tab.openedAt;
  const status = thread ? thread.status === "working" || thread.status === "queued" ? "running" : thread.status : subagentViewStatus(active, tab.subagentStatus);
  const running = status === "running";
  const finished = thread ? ["completed", "failed", "interrupted", "closed"].includes(thread.status) : subagentFinished(status);

  useEffect(() => {
    setThread(undefined);
    setThreadMessages([]);
    if (!subagentId?.startsWith("agent-")) return;
    let cancelled = false;
    const adopt = (next: AgentThread | undefined) => {
      if (!cancelled && next) setThread((current) => !current || next.revision > current.revision ? next : current);
    };
    const stop = onEvent((event) => {
      if (event.type !== "agent_thread_changed" || event.conversationId !== conversationId) return;
      const next = event.thread as AgentThread | undefined;
      if (next?.id !== subagentId) return;
      adopt(next);
      void getAgentThreadMessages(subagentId, conversationId).then((messages) => { if (!cancelled) setThreadMessages(messages); }).catch(() => undefined);
    });
    void Promise.all([getAgentThreads(conversationId), getAgentThreadMessages(subagentId, conversationId)]).then(([threads, messages]) => {
      if (!cancelled) { adopt(threads.find((item) => item.id === subagentId)); setThreadMessages(messages); }
    }).catch(() => undefined);
    return () => { cancelled = true; stop(); };
  }, [subagentId, conversationId]);


  useEffect(() => {
    setLoaded(null);
    if (subagentId?.startsWith("agent-")) return;
    void getSubagents(conversationId).then(useSessionStore.getState().setSubagents).catch(() => undefined);
  }, [subagentId, conversationId]);

  // The current turn's cache contains its tools and thinking as well as the final
  // reply. Mailbox results alone cannot reconstruct that execution transcript.
  useEffect(() => {
    if (!runId || !finished) return;
    let cancelled = false;
    void getSubagentMessages(runId, conversationId).then((result) => {
      if (!cancelled && result.length > 0) setLoaded({ runId, messages: result });
    }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [runId, finished, conversationId]);

  const brief = useMemo<ChatMessage | null>(() => {
    if (!task) return null;
    return { id: `${subagentId ?? tab.id}:brief`, role: "user", text: task, tools: [], parts: [{ kind: "text", text: task }], createdAt: startedAt };
  }, [startedAt, subagentId, tab.id, task]);

  const currentTurn = (finished && loaded?.runId === runId ? loaded.messages : streamed) ?? [];
  const body = currentTurn.length ? currentTurn : thread ? threadMessagesToChat(thread, threadMessages) : [];
  const messages = useMemo(() => {
    // The cached transcript repeats the delegated turn the engine stored; the brief
    // already stands for it.
    if (body.some((item) => item.role === "user")) return body;
    return brief ? [brief, ...body] : body;
  }, [body, brief]);

  const noop = (): void => undefined;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2 border-b border-border/50 px-3 py-2">
        <AgentAvatar seed={thread?.avatarSeed ?? active?.avatarSeed ?? tab.subagentAvatarSeed ?? 0} size="size-7" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium">{thread?.name ?? active?.name ?? tab.title}</div>
          <div className="truncate text-xs text-muted-foreground">{thread?.agent ?? active?.agent ?? t("subagent.title")}</div>
        </div>
      </div>
      <div className="min-h-0 flex-1">
        {messages.length === 0 ? (
          <SubagentEmpty />
        ) : (
          <MessageList
            messages={messages}
            streaming={running}
            conversationId={conversationId}
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
          placeholder={t("subagent.readOnlyStatus", { status: subagentStatusText(undefined, status) })}
          models={models}
          model={active?.model}
          thinkingLevel={active?.thinkingLevel}
          workspaceLabel=""
          projects={[]}
          commands={[]}
          queued={[]}
          queuePause={null}
          attachments={[]}
          history={() => []}
          contextPercent={usagePercent(active ?? null)}
          contextUsage={active?.contextUsage}
          onChange={noop}
          onSubmit={noop}
          onAbort={() => {
            if (!subagentId) return;
            const action = subagentId.startsWith("agent-") ? interruptAgent(subagentId, conversationId) : abortSubagent(subagentId, conversationId);
            void action.catch((error: unknown) => toast.error(String(error)));
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
  prev.tab.subagentAvatarSeed === next.tab.subagentAvatarSeed &&
  prev.tab.subagentBrief === next.tab.subagentBrief &&
  prev.tab.openedAt === next.tab.openedAt &&
  prev.tab.conversationId === next.tab.conversationId &&
  prev.tab.subagentConversationId === next.tab.subagentConversationId &&
  prev.tab.subagentStatus === next.tab.subagentStatus,
);
