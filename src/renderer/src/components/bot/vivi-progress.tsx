import { useEffect, useState, type JSX } from "react";
import { useTranslation } from "react-i18next";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Spinner } from "@/components/ui/spinner";
import { RunningMark } from "@/components/running-mark";
import { formatDuration } from "@/lib/time";
import type { BotProgress } from "@shared/bot";

export const LIVE_PHASES = new Set(["accepted", "understanding", "planning", "delegating", "working", "summarizing"]);
function Elapsed({ startedAt }: { startedAt: number }): JSX.Element {
  const [now, setNow] = useState(Date.now);
  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), 1000); return () => window.clearInterval(timer); }, []);
  return <span role="timer" className="shrink-0 text-xs tabular-nums text-muted-foreground">{formatDuration(Math.floor(Math.max(0, now - startedAt) / 1000) * 1000)}</span>;
}

export function ViviProgressFooter({ progress, sending, fallbackRunning, busy, onStatus, onTasks, onStopAll, onContinue, onCompose }: {
  progress: BotProgress[]; sending?: boolean; fallbackRunning?: boolean; busy?: boolean;
  onStatus: () => void; onTasks: () => void; onStopAll: () => void;
  onContinue: (conversationId: string) => void; onCompose: () => void;
}): JSX.Element | null {
  const { t } = useTranslation("app");
  const active = progress.filter((item) => !["idle", "completed", "failed", "interrupted"].includes(item.phase));
  const running = active.some((item) => LIVE_PHASES.has(item.phase)) || (!progress.length && fallbackRunning);
  const latest = active.find((item) => LIVE_PHASES.has(item.phase)) ?? active[0];
  if (!sending && !latest && !running) return null;
  return <Card size="sm" data-slot="vivi-progress" className="mb-3 gap-0 px-3 text-sm">
    <div className="flex items-start gap-2">
      {sending ? <Spinner className="mt-0.5 size-3.5" /> : running ? <RunningMark /> : <span className="mt-1 size-2 shrink-0 rounded-full bg-warning" />}
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2"><span role="status" className="font-medium">{t(sending ? "viviBot.sending" : latest ? `viviBot.phase.${latest.phase}` : "viviBot.status.running")}</span>{!sending && latest && LIVE_PHASES.has(latest.phase) ? <Elapsed key={latest.inputId} startedAt={latest.startedAt} /> : null}</div>
        {!sending && latest?.title ? <div className="mt-0.5 wrap-anywhere text-xs text-muted-foreground">{latest.title}</div> : null}
        {!sending && latest?.detail ? <div className="mt-1 whitespace-pre-wrap wrap-anywhere text-sm text-foreground/80">{latest.detail}</div> : null}
        {latest?.queuedCount ? <div className="mt-1 text-xs text-muted-foreground">{t("viviBot.pendingMessages", { count: latest.queuedCount })}</div> : null}
      </div>
    </div>
    {active.length > 1 ? <Collapsible className="mt-2"><CollapsibleTrigger className="text-xs text-muted-foreground underline underline-offset-2">{t("viviBot.moreActive", { count: active.length - 1 })}</CollapsibleTrigger><CollapsibleContent><div className="mt-2 max-h-48 space-y-2 overflow-y-auto">{active.filter((item) => item !== latest).map((item) => <div key={item.conversationId} className="text-xs"><span className="font-medium">{item.title ?? "Vivi"}</span> · {t(`viviBot.phase.${item.phase}`)}{item.detail ? <p className="mt-0.5 wrap-anywhere text-muted-foreground">{item.detail}</p> : null}</div>)}</div></CollapsibleContent></Collapsible> : null}
    <div className="mt-2 flex flex-wrap items-center gap-1">
      <Button size="xs" variant="ghost" disabled={busy || sending} onClick={onStatus}>{t("viviBot.askStatus")}</Button>
      <Button size="xs" variant="ghost" onClick={onTasks}>{t("viviBot.tasks")}</Button>
      <Button size="xs" variant="ghost" onClick={onCompose}>{t("viviBot.keepTalking")}</Button>
      {running ? <Button size="xs" variant="ghost" disabled={busy} onClick={onStopAll}>{t("viviBot.stopAll")}</Button> : null}
      {latest && ["paused", "failed", "interrupted"].includes(latest.phase) ? <Button size="xs" variant="outline" disabled={busy} onClick={() => onContinue(latest.conversationId)}>{t("viviBot.continue")}</Button> : null}
    </div>
  </Card>;
}
