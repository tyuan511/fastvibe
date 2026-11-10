import { useEffect, useRef, useState, type JSX } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ReviewStartDialog } from "./review-start-dialog";
import { ReviewCode } from "./review-code";
import { cn } from "@/lib/utils";
import { resolvePath } from "@/lib/workspace-path";
import { useSessionStore } from "@/stores/session";
import { useSidePaneStore } from "@/stores/side-pane";
import type { AgentThread } from "@shared/agent-thread";
import type { ReviewFinding, ReviewReport } from "@shared/review";

const SEVERITIES = ["P0", "P1", "P2", "P3"] as const;
const SEVERITY_STYLE = { P0: "border-destructive/30 text-destructive", P1: "border-destructive/30 text-destructive", P2: "border-warning/40 text-warning", P3: "text-muted-foreground" };

function FindingCard({ finding, cwd, conversationId }: { finding: ReviewFinding; cwd: string; conversationId: string }): JSX.Element {
  const { t } = useTranslation("sidepane");
  const location = finding.location;
  async function openFile(): Promise<void> {
    if (useSessionStore.getState().activeId !== conversationId) return;
    try {
      const preview = await window.fastvibe.workspace.preview(resolvePath(location.path, cwd));
      if (useSessionStore.getState().activeId === conversationId) useSidePaneStore.getState().openFilePreview(preview);
    } catch (cause) {
      if (useSessionStore.getState().activeId === conversationId) toast.error(cause instanceof Error ? cause.message : t("review.openFailed"));
    }
  }
  return <Collapsible defaultOpen className="min-w-0 rounded-lg border border-border bg-card/40">
    <CollapsibleTrigger render={<Button variant="ghost" className="h-auto w-full justify-start gap-2 px-3 py-3 text-left whitespace-normal" />}>
      <Badge variant="outline" className={cn("self-start", SEVERITY_STYLE[finding.severity])}>{finding.severity}</Badge>
      <span className="min-w-0 flex-1 text-sm font-medium wrap-anywhere">{finding.title}</span>
      <span className="shrink-0 text-xs text-muted-foreground">{t(`review.confidence.${finding.confidence}`)}</span>
    </CollapsibleTrigger>
    <CollapsibleContent>
      <div className="space-y-3 border-t border-border/50 p-3 text-sm">
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
          <span className="wrap-anywhere">{location.path}:{location.startLine}{location.endLine !== location.startLine ? `–${location.endLine}` : ""}</span>
        </div>
        {location.snippet ? <ReviewCode path={location.path} snippet={location.snippet} startLine={location.startLine} /> : null}
        <div><p className="mb-1 text-xs font-medium text-muted-foreground">{t("review.trigger")}</p><p className="whitespace-pre-wrap wrap-anywhere">{finding.trigger}</p></div>
        <div><p className="mb-1 text-xs font-medium text-muted-foreground">{t("review.impact")}</p><p className="whitespace-pre-wrap wrap-anywhere">{finding.impact}</p></div>
        <div><p className="mb-1 text-xs font-medium text-muted-foreground">{t("review.evidence")}</p><ul className="list-disc space-y-1 pl-4">{finding.evidence.map((item, index) => <li key={index} className="whitespace-pre-wrap wrap-anywhere">{item}</li>)}</ul></div>
        <div><p className="mb-1 text-xs font-medium text-muted-foreground">{t("review.recommendation")}</p><p className="whitespace-pre-wrap wrap-anywhere">{finding.recommendation}</p></div>
        <Button size="sm" variant="outline" onClick={() => void openFile()}>{t("review.openCurrentFile")}</Button>
      </div>
    </CollapsibleContent>
  </Collapsible>;
}

export function ReviewReportView({ thread, report, running, focusFindingId, focusRevision, showAll }: {
  thread: AgentThread;
  report?: ReviewReport;
  running: boolean;
  focusFindingId?: string;
  focusRevision?: number;
  /** The chat card's 查看: every issue at once, in report order, already expanded. */
  showAll?: boolean;
}): JSX.Element {
  const { t } = useTranslation("sidepane");
  const [severity, setSeverity] = useState("all");
  const [reviewAgain, setReviewAgain] = useState(false);
  const [selectedId, setSelectedId] = useState(focusFindingId);
  const selectedDetail = useRef<HTMLDivElement>(null);
  useEffect(() => {
    setSeverity("all");
    setSelectedId(focusFindingId);
  }, [focusFindingId, focusRevision, thread.id]);
  const selectedFinding = report?.findings.find((finding) => finding.id === selectedId);
  useEffect(() => {
    if (!selectedFinding) return;
    selectedDetail.current?.scrollIntoView({ block: "start" });
    selectedDetail.current?.focus({ preventScroll: true });
  }, [selectedFinding?.id, focusRevision]);
  const context = thread.review;
  if (!context) return <></>;
  const counts = { P0: 0, P1: 0, P2: 0, P3: 0 };
  for (const finding of report?.findings ?? []) counts[finding.severity]++;
  const findings = report?.findings.filter((finding) => severity === "all" || finding.severity === severity) ?? [];
  const skipped = report?.coverage.unreviewedPaths ?? context.files.filter((file) => file.skipped).map((file) => ({ path: file.path, reason: file.skipped! }));
  const noReportState = thread.status === "failed" || thread.status === "interrupted" ? thread.status : "incomplete";
  const reportState = running ? "running" : !report ? noReportState : report.findings.length ? "hasFindings" : skipped.length ? "partial" : "noFindings";

  return <div data-review-report className="h-full min-h-0 min-w-0 overflow-x-hidden overflow-y-auto [scrollbar-gutter:stable]">
    <div className="space-y-4 p-3">
      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="min-w-0 flex-1 text-sm font-semibold">{t(report ? `review.states.${reportState}` : "review.report")}</h3>
          {!running ? <Button size="sm" variant="outline" onClick={() => setReviewAgain(true)}>{t("review.again")}</Button> : null}
        </div>
      </div>
      {report && (thread.status === "failed" || thread.status === "interrupted") && thread.lastMessage ? <p role="status" className="rounded-md bg-muted/50 p-3 text-sm whitespace-pre-wrap wrap-anywhere">{thread.lastMessage}</p> : null}
      {report && showAll ? <>
        {report.findings.length === 0 ? <p className="rounded-lg border border-dashed border-border p-4 text-sm text-muted-foreground">{t(skipped.length ? "review.noFindingsPartial" : "review.noFindingsDescription")}</p> : null}
        <div className="space-y-3">{report.findings.map((finding) => <FindingCard key={finding.id} finding={finding} cwd={context.root} conversationId={thread.conversationId} />)}</div>
      </> : report && selectedFinding ? <div ref={selectedDetail} tabIndex={-1} data-review-selected-finding={selectedFinding.id} className="min-w-0 space-y-3 rounded-lg ring-2 ring-ring/50 outline-none">
        <Button size="sm" variant="ghost" onClick={() => { setSelectedId(undefined); setSeverity("all"); }}>{t("review.backToReport")}</Button>
        <FindingCard key={`${selectedFinding.id}:${focusRevision ?? 0}`} finding={selectedFinding} cwd={context.root} conversationId={thread.conversationId} />
      </div> : report ? <>
        {selectedId ? <p role="status" className="text-sm text-muted-foreground">{t("review.findingUnavailable")}</p> : null}
        <p className="text-sm whitespace-pre-wrap wrap-anywhere">{report.summary}</p>
        <div className="flex flex-wrap items-center gap-1.5">{SEVERITIES.map((level) => <Badge key={level} variant="outline" className={SEVERITY_STYLE[level]}>{level} · {counts[level]}</Badge>)}</div>
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs text-muted-foreground">{t("review.findingCount", { count: report.findings.length })}</span>
          <Select value={severity} onValueChange={(value) => { if (value !== null) setSeverity(value); }}>
            <SelectTrigger size="sm" aria-label={t("review.filterLabel")}><SelectValue>{severity === "all" ? t("review.allSeverities") : severity}</SelectValue></SelectTrigger>
            <SelectContent><SelectItem value="all">{t("review.allSeverities")}</SelectItem>{SEVERITIES.map((level) => <SelectItem key={level} value={level}>{level}</SelectItem>)}</SelectContent>
          </Select>
        </div>
        <div className="space-y-3">{findings.map((finding) => <FindingCard key={finding.id} finding={finding} cwd={context.root} conversationId={thread.conversationId} />)}</div>
        {findings.length === 0 ? <p className="rounded-lg border border-dashed border-border p-4 text-sm text-muted-foreground">{t(report.findings.length ? "review.noFilterMatches" : skipped.length ? "review.noFindingsPartial" : "review.noFindingsDescription")}</p> : null}
      </> : <div className="rounded-lg border border-dashed border-border p-4 text-sm text-muted-foreground">
        <p>{t(`review.${running ? "running" : noReportState}Description`)}</p>
        {!running && noReportState !== "incomplete" && thread.lastMessage ? <p className="mt-2 whitespace-pre-wrap wrap-anywhere">{thread.lastMessage}</p> : null}
      </div>}
    </div>
    {reviewAgain ? <ReviewStartDialog open onOpenChange={setReviewAgain} cwd={context.root} conversationId={thread.conversationId} defaultScope={context.scope} initialBase={context.comparisonBase} initialInstructions={context.instructions} revision={context.scope === "commit" ? context.target : undefined} /> : null}
  </div>;
}
