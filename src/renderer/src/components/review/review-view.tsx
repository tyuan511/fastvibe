import { useEffect, useState, type JSX } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { getAgentThreads, interruptAgent, onEvent } from "@/lib/engine-client";
import { useSessionStore } from "@/stores/session";
import type { SidePaneTab } from "@/stores/side-pane";
import { findSubagent } from "@shared/subagent-state";
import type { AgentThread } from "@shared/agent-thread";
import { ReviewReportView } from "./review-report";

/** Review owns its report and progress surface; no chat transcript or composer. */
export function ReviewView({ tab }: { tab: SidePaneTab }): JSX.Element {
  const { t } = useTranslation("sidepane");
  const threadId = tab.reviewThreadId ?? tab.subagentId;
  const conversationId = tab.conversationId;
  const [loaded, setLoaded] = useState<AgentThread>();
  const [loadError, setLoadError] = useState("");
  const [stopping, setStopping] = useState(false);
  // Validate during render too: effects run after a tab owner can change.
  const thread = loaded && loaded.id === threadId && loaded.conversationId === conversationId ? loaded : undefined;
  const runId = thread ? `${thread.id}:turn:${thread.currentTurn ?? 1}` : undefined;
  const runtime = useSessionStore((state) => runId ? findSubagent(state.subagents, runId, conversationId) : undefined);
  const context = thread?.review;
  const running = !!thread && ["queued", "working", "waiting"].includes(thread.status);
  const phase = runtime?.phase ?? thread?.phase ?? (thread?.status === "queued" ? "queued" : thread?.status === "waiting" ? "waiting" : "working");
  const state = running ? "running" : thread?.status === "failed" || thread?.status === "interrupted" ? thread.status : thread?.reviewReport ? "completed" : "incomplete";

  useEffect(() => {
    setLoaded(undefined);
    setLoadError("");
    setStopping(false);
    if (!threadId || !conversationId) return;
    let cancelled = false;
    const adopt = (next: AgentThread | undefined): void => {
      if (cancelled || next?.id !== threadId || next.conversationId !== conversationId) return;
      setLoaded((current) => !current || current.id !== threadId || current.conversationId !== conversationId || next.revision > current.revision ? next : current);
    };
    // Subscribe before reading; revision prevents an older snapshot overwriting a push.
    const unsubscribe = onEvent((event) => {
      if (event.type === "agent_thread_changed" && event.conversationId === conversationId) adopt(event.thread as AgentThread | undefined);
    });
    void getAgentThreads(conversationId).then((threads) => {
      if (cancelled) return;
      const next = threads.find((item) => item.id === threadId && item.conversationId === conversationId);
      adopt(next);
      if (!next) setLoadError(t("review.notFound"));
    }).catch((cause: unknown) => {
      if (!cancelled) setLoadError(cause instanceof Error ? cause.message : t("review.loadFailed"));
    });
    return () => { cancelled = true; unsubscribe(); };
  }, [threadId, conversationId, t]);

  async function stop(): Promise<void> {
    if (!threadId || !conversationId || stopping) return;
    setStopping(true);
    try { await interruptAgent(threadId, conversationId); }
    catch (cause) { toast.error(cause instanceof Error ? cause.message : t("review.stopFailed")); }
    finally { setStopping(false); }
  }

  return <div data-review-view className="flex min-h-0 min-w-0 flex-1 flex-col">
    <header className="shrink-0 space-y-2 border-b border-border/50 px-3 py-3">
      <div className="flex items-center gap-2">
        <h2 className="min-w-0 flex-1 text-sm font-semibold">{t("review.title")}</h2>
        {thread ? <Badge variant="secondary">{t(`review.states.${state}`)}</Badge> : !loadError ? <Spinner className="size-4" /> : null}
        {running ? <Button size="sm" variant="outline" disabled={stopping} onClick={() => void stop()}>{stopping ? <Spinner /> : null}{t(stopping ? "review.stopping" : "review.stop")}</Button> : null}
      </div>
      {context ? <>
        <p className="text-xs text-muted-foreground">{t(`review.scopes.${context.scope}`)}</p>
      </> : null}
      {running ? <p role="status" className="flex items-center gap-2 text-xs text-muted-foreground"><Spinner className="size-3" />{t(`review.phases.${phase}`)}</p> : null}
    </header>
    <div className="min-h-0 flex-1">
      {thread && context ? <ReviewReportView key={`${conversationId}:${thread.id}`} thread={thread} report={thread.reviewReport} running={running} focusFindingId={tab.reviewFindingId} focusRevision={tab.reviewFocusRevision} showAll={tab.reviewShowAll} /> : <p role="status" className="p-4 text-sm text-muted-foreground whitespace-pre-wrap wrap-anywhere">{loadError || t(thread ? "review.notFound" : "review.loading")}</p>}
    </div>
  </div>;
}
