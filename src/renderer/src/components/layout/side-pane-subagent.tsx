import { useEffect, useMemo, useState, type JSX } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { BotIcon } from "@hugeicons/core-free-icons";
import { SidePaneChat } from "@/components/layout/side-pane-chat";
import { useSessionStore } from "@/stores/session";
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
 * The transcript reads like any chat: the delegated brief as the opening user
 * message, then the role's own assistant turns. Only the assistant side streams
 * (Main slims the sub-session's `message_end` down to failures), so the brief is
 * rebuilt here from the run's `detail`.
 */
export function SidePaneSubagent({ tab }: { tab: SidePaneTab }): JSX.Element {
  const subagents = useSessionStore((state) => state.subagents);
  const streams = useSessionStore((state) => state.subagentStreams);
  const subagentId = tab.subagentId ?? null;
  const [loaded, setLoaded] = useState<ChatMessage[] | null>(null);

  const active = subagentId ? subagents.find((item) => item.id === subagentId) : undefined;
  const streamed = subagentId ? streams[subagentId] : undefined;

  // A run that finished before its tab was opened has no live stream to replay;
  // pull its cached transcript once. `loaded` (even empty) marks it as fetched.
  useEffect(() => {
    setLoaded(null);
    if (!subagentId || streamed?.length) return;
    let cancelled = false;
    void window.fastvibe.engine
      .getSubagentMessages(subagentId)
      .then((result) => {
        if (!cancelled) setLoaded(result);
      })
      .catch(() => {
        if (!cancelled) setLoaded([]);
      });
    return () => {
      cancelled = true;
    };
    // `streamed` is intentionally not a dependency: a late live stream should not
    // re-trigger the cache read, and the tab id changing resets it explicitly.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [subagentId]);

  const messages = useMemo(() => {
    const body = streamed ?? loaded ?? [];
    const task = active?.detail?.trim();
    if (!task) return body;
    const brief: ChatMessage = {
      id: `${subagentId}:brief`,
      role: "user",
      text: task,
      tools: [],
      createdAt: active?.startedAt ?? body[0]?.createdAt ?? 0,
    };
    return [brief, ...body];
  }, [active?.detail, active?.startedAt, loaded, streamed, subagentId]);

  return (
    <SidePaneChat
      tab={tab}
      readOnly
      messages={messages}
      streaming={active?.status === "running"}
      emptyState={<SubagentEmpty />}
      placeholder="子 Agent 只读"
    />
  );
}
