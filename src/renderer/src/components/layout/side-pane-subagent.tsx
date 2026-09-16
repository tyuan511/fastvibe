import { memo, useEffect, useMemo, useState, type JSX } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { BotIcon } from "@hugeicons/core-free-icons";
import { MessageList } from "@/components/chat/message-list";
import { useSessionStore } from "@/stores/session";
import { useSettingsStore } from "@/stores/settings";
import type { ChatMessage } from "@shared/types";
import type { SidePaneTab } from "@/stores/side-pane";

function SubagentEmpty(): JSX.Element {
  return (
    <div className="flex h-full flex-col items-center justify-center px-6 text-center">
      <div className="flex size-10 items-center justify-center rounded-2xl bg-muted text-muted-foreground">
        <HugeiconsIcon strokeWidth={2} icon={BotIcon} className="size-5" />
      </div>
      <h2 className="mt-3 text-base font-semibold tracking-tight">子 Agent</h2>
      <p className="mt-1 max-w-[16rem] text-sm leading-5 text-muted-foreground">
        主 Agent 委派子任务时，这里会实时显示它在隔离上下文里的完整对话。
      </p>
    </div>
  );
}

/**
 * One delegated run, in its own right-pane tab. Each run gets a distinct tab
 * (`subagent:<toolCallId>:<index>`), so parallel/chain runs — and runs from
 * different conversations — never share a view.
 *
 * Read-only: no composer, no abort. The transcript matches the main thread —
 * same `MessageList`, same follow-the-bottom scroller — with the delegated brief
 * as the opening user message (the sub-session's live stream never includes that
 * user turn) followed by the role's own assistant turns.
 *
 * Everything the pane draws is derived from two stable sources: the run's tab
 * (which pins the brief) and the store's per-run stream. Nothing here reads
 * `subagents` for its content — that list is replaced on every `getSubagents`
 * snapshot, and deriving the brief from it blanked the transcript mid-flight.
 */
export const SidePaneSubagent = memo(function SidePaneSubagent({ tab }: { tab: SidePaneTab }): JSX.Element {
  const subagentId = tab.subagentId ?? null;
  const active = useSessionStore((state) =>
    subagentId ? state.subagents.find((item) => item.id === subagentId) : undefined,
  );
  const streamed = useSessionStore((state) => (subagentId ? state.subagentStreams[subagentId] : undefined));
  const showThinking = useSettingsStore((state) => state.settings.showThinking);
  const showTimestamp = useSettingsStore((state) => state.settings.showTimestamps);
  const collapseRuns = useSettingsStore((state) => state.settings.collapseRuns);
  const [loaded, setLoaded] = useState<ChatMessage[] | null>(null);

  const task = (tab.subagentBrief ?? active?.detail ?? "").trim();
  // `tab.openedAt` keeps the value defined, so the brief's identity never changes
  // when the engine's snapshot finally carries the run's real `startedAt`.
  const startedAt = active?.startedAt ?? tab.openedAt;
  const status = active?.status;
  const running = status === "running";

  useEffect(() => {
    setLoaded(null);
  }, [subagentId]);

  // Pull the cached transcript exactly once, when the run is over. Reading it while
  // the run was live mixed a mid-flight snapshot into the growing stream and swapped
  // the whole list — the pane flickered, and the authoritative mapping is only
  // written at the end anyway.
  useEffect(() => {
    if (!subagentId || running) return;
    let cancelled = false;
    void window.fastvibe.engine
      .getSubagentMessages(subagentId)
      .then((result) => {
        if (!cancelled && result.length > 0) setLoaded(result);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [subagentId, running]);

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

  const body = (running ? streamed : loaded ?? streamed) ?? [];
  const messages = useMemo(() => {
    // The cached transcript repeats the delegated turn the engine stored; the brief
    // already stands for it.
    if (body.some((item) => item.role === "user")) return body;
    return brief ? [brief, ...body] : body;
  }, [body, brief]);

  // Decided here rather than left to `MessageList`: the empty state and the scroller
  // are different trees, and flipping between them on every transient change is what
  // reads as flicker.
  if (messages.length === 0) return <SubagentEmpty />;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1">
        <MessageList
          messages={messages}
          streaming={running}
          showThinking={showThinking}
          showTimestamp={showTimestamp}
          // A delegated run is an agent run too, and its transcript is read the same
          // way — a dozen tool rows around one answer — so 折叠运行过程 applies here.
          collapseRuns={collapseRuns}
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
  prev.tab.openedAt === next.tab.openedAt,
);
