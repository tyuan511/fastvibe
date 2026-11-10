import { useEffect, useRef, useState, type JSX } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { interruptAgent } from "@/lib/engine-client";
import { sendReviewRepair } from "@/lib/review-repair";
import { useSessionStore } from "@/stores/session";
import { useSidePaneStore } from "@/stores/side-pane";
import type { AgentThread } from "@shared/agent-thread";
import { findSubagent } from "@shared/subagent-state";

const SEVERITY_STYLE = {
  P0: "border-destructive/30 text-destructive",
  P1: "border-destructive/30 text-destructive",
  P2: "border-warning/40 text-warning",
  P3: "text-muted-foreground",
} as const;

/** The parent owns thread updates; issue details live in the dedicated report pane. */
export function ReviewChatCard({ thread }: { thread: AgentThread }): JSX.Element {
  const { t } = useTranslation("sidepane");
  const [stopping, setStopping] = useState(false);
  const [repairState, setRepairState] = useState<"idle" | "sending" | "sent">("idle");
  const sending = useRef(false);
  const sentTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(sentTimer.current), []);
  const report = thread.reviewReport;
  const running = ["queued", "working", "waiting"].includes(thread.status);
  const runId = `${thread.id}:turn:${thread.currentTurn ?? 1}`;
  const runtime = useSessionStore((session) => findSubagent(session.subagents, runId, thread.conversationId));
  const phase = runtime?.phase ?? thread.phase ?? (thread.status === "queued" ? "queued" : thread.status === "waiting" ? "waiting" : "working");
  const findings = report?.findings ?? [];
  const repairAvailable = thread.status === "completed" && !!thread.review && !!report && findings.length > 0;
  const uncovered = new Set(report?.coverage.unreviewedPaths.map((file) => file.path));
  for (const file of thread.review?.files ?? []) {
    if (file.skipped || (report && !report.coverage.reviewedPaths.includes(file.path))) uncovered.add(file.path);
  }
  const state = thread.status === "failed" || thread.status === "interrupted" ? thread.status : "incomplete";
  const notice = running ? t(`review.phases.${phase}`)
    : state !== "incomplete" ? `${t(`review.states.${state}`)}${thread.lastMessage ? ` · ${thread.lastMessage}` : ""}`
    : thread.status !== "completed" || !report ? t("review.incompleteDescription")
    : uncovered.size ? t("review.chat.uncovered", { count: uncovered.size })
    : !findings.length ? t("review.noFindingsDescription") : "";

  function openReport(findingId?: string, showAll?: boolean): void {
    useSidePaneStore.getState().openReview(thread.id, thread.conversationId, false, findingId, showAll);
  }

  async function stop(): Promise<void> {
    if (stopping) return;
    setStopping(true);
    try { await interruptAgent(thread.id, thread.conversationId); }
    catch (cause) { toast.error(cause instanceof Error ? cause.message : t("review.stopFailed")); }
    finally { setStopping(false); }
  }

  async function fixAll(): Promise<void> {
    if (sending.current || !repairAvailable) return;
    sending.current = true;
    clearTimeout(sentTimer.current);
    setRepairState("sending");
    try {
      await sendReviewRepair(thread);
      setRepairState("sent");
      sentTimer.current = setTimeout(() => { sending.current = false; setRepairState("idle"); }, 2000);
    } catch (cause) {
      sending.current = false;
      setRepairState("idle");
      toast.error(t("review.repair.fixFailed"), { description: cause instanceof Error ? cause.message : undefined });
    }
  }

  return <section data-review-chat-card={thread.id} aria-label={t("review.title")} className="w-full min-w-0 max-w-full rounded-lg border border-border bg-card/40 text-sm">
    <header className="flex min-w-0 items-center justify-between gap-2 px-3 py-2">
      <h3 className="min-w-0 shrink text-sm font-semibold">{t("review.title")}</h3>
      <div className="flex shrink-0 items-center gap-1.5">
        {running ? <Button size="sm" variant="ghost" disabled={stopping} onClick={() => void stop()}>{stopping ? <Spinner /> : null}{t(stopping ? "review.stopping" : "review.stop")}</Button>
          : <Button size="sm" variant="ghost" disabled={!repairAvailable || repairState !== "idle"} aria-label={t(`review.repair.${repairState === "sending" ? "fixing" : repairState === "sent" ? "fixSent" : "fixAll"}`)} title={!repairAvailable ? t("review.repair.repairUnavailable") : undefined} onClick={() => void fixAll()}>{repairState === "sending" ? <Spinner /> : null}<span aria-live="polite">{t(`review.repair.${repairState === "sending" ? "fixing" : repairState === "sent" ? "fixSent" : "fixAll"}`)}</span></Button>}
        <Button size="sm" variant="outline" className="rounded-full" onClick={() => openReport(undefined, true)}>{t("review.viewAll")}</Button>
      </div>
    </header>
    {notice ? <button type="button" onClick={() => openReport()} title={notice} className="block w-full min-w-0 border-t border-border/50 px-3 py-2 text-left text-xs text-muted-foreground hover:bg-muted/50 focus-visible:outline-2 focus-visible:outline-ring"><span className="line-clamp-1 wrap-anywhere">{notice}</span></button> : null}
    {!running ? findings.map((finding) => <button type="button" key={finding.id} data-review-finding={finding.id} onClick={() => openReport(finding.id)} className="block w-full min-w-0 space-y-1 border-t border-border/50 px-3 py-3 text-left hover:bg-muted/50 focus-visible:outline-2 focus-visible:outline-ring">
      <span className="flex min-w-0 items-center gap-2">
        <Badge variant="outline" className={`shrink-0 ${SEVERITY_STYLE[finding.severity]}`}>{finding.severity}</Badge>
        <span className="min-w-0 text-sm font-medium wrap-anywhere">{finding.title}</span>
      </span>
      <span className="line-clamp-1 text-sm text-muted-foreground wrap-anywhere">{finding.impact}</span>
    </button>) : null}
  </section>;
}
