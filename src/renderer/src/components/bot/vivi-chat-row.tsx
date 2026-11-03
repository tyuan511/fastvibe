import { useState, type JSX } from "react";
import { useNavigate } from "react-router";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useSidePaneStore } from "@/stores/side-pane";
import { useBotSnapshot } from "./use-bot-snapshot";
import { LIVE_PHASES } from "./vivi-progress";
import { useTranslation } from "react-i18next";
import { HugeiconsIcon } from "@hugeicons/react";
import { AlertCircleIcon, CheckmarkCircle02Icon, Clock01Icon, InformationCircleIcon } from "@hugeicons/core-free-icons";
import { resolvePath } from "@/lib/workspace-path";
import { PathLink } from "@/components/path-menu";
import { cn } from "@/lib/utils";
import { resultTone } from "./bot-status";
import type { ChatMessage } from "@shared/types";

function statusIcon(status: string) {
  if (status === "ready") return CheckmarkCircle02Icon;
  if (status === "failed" || status === "uncertain") return AlertCircleIcon;
  if (status === "blocked") return Clock01Icon;
  return InformationCircleIcon;
}

export function ViviChatRow({ message }: { message: ChatMessage }): JSX.Element {
  const { t } = useTranslation("app");
  const { snapshot, adopt } = useBotSnapshot();
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const bot = message.bot;
  if (!bot) return <></>;
  if (bot.kind === "progress") {
    return <div data-slot="vivi-milestone" className="flex w-full max-w-2xl items-start gap-2 rounded-lg border border-border/60 bg-muted/20 px-3 py-2 text-sm text-muted-foreground">
      <span className="mt-1 size-2 shrink-0 rounded-full bg-primary" />
      <span className="min-w-0 wrap-anywhere">{message.text}</span>
    </div>;
  }
  if (bot.kind === "status") {
    return <div className="flex w-full max-w-2xl items-start gap-2 rounded-lg border border-border/60 bg-muted/20 px-3 py-2 text-sm text-muted-foreground">
      <HugeiconsIcon strokeWidth={2} icon={InformationCircleIcon} className="mt-0.5 size-4 shrink-0" />
      <span className="min-w-0 wrap-anywhere">{message.text}</span>
    </div>;
  }
  const result = bot.result;
  const status = result?.status ?? "idle";
  const cwd = snapshot?.conversations.find((item) => item.conversationId === bot.conversationId)?.project;
  const current = snapshot?.progress?.find((item) => item.conversationId === bot.conversationId);
  const latestResult = snapshot?.results.filter((item) => item.conversationId === bot.conversationId).at(-1);
  const pendingQuestion = snapshot?.attention.some((item) => item.conversationId === bot.conversationId && item.status === "pending");
  const canContinue = Boolean(!pendingQuestion && result && current && !LIVE_PHASES.has(current.phase) && ["failed", "uncertain", "idle", "blocked"].includes(status) && latestResult?.id === result.id && (!current.inputId || current.inputId === result.inputId));
  const resume = async (): Promise<void> => {
    if (busy || !canContinue) return;
    setBusy(true); setError(null);
    try { adopt(await window.fastvibe.bot.continueConversation({ conversationId: bot.conversationId })); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  };
  return <Card size="sm" data-slot="vivi-result" className="w-full max-w-2xl gap-0 px-3">
    <div className={cn("flex items-center gap-2 text-sm font-medium", resultTone(status))}>
      <HugeiconsIcon strokeWidth={2} icon={statusIcon(status)} className="size-4 shrink-0" />
      <span>{t(`viviBot.resultStatus.${status}`, status)}</span>
      {bot.title ? <span className="min-w-0 truncate text-foreground">· {bot.title}</span> : null}
    </div>
    {result?.summary || message.text ? <p className="mt-2 whitespace-pre-wrap wrap-anywhere text-sm leading-5 text-foreground/90">{result?.summary ?? message.text}</p> : null}
    {result?.evidence?.length ? <div className="mt-2 space-y-1 text-xs text-muted-foreground"><div className="font-medium text-foreground/80">{t("viviBot.evidence")}</div>{result.evidence.map((item, index) => <div key={`${index}:${item}`} className="wrap-anywhere">· {item}</div>)}</div> : null}
    {result?.artifacts?.length ? <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs">{result.artifacts.map((path) => <PathLink key={path} path={resolvePath(path, cwd)}>{path}</PathLink>)}</div> : null}
    <div className="mt-3 flex flex-wrap gap-1">
      <Button size="xs" variant="ghost" onClick={() => useSidePaneStore.getState().openBotConversation(bot.conversationId, bot.title)}>{t("viviBot.execution")}</Button>
      {canContinue ? <Button size="xs" variant="outline" disabled={busy} onClick={() => void resume()}>{t("viviBot.continue")}</Button> : null}
      <Button size="xs" variant="ghost" onClick={() => navigate(`/vivi?followup=${encodeURIComponent(bot.conversationId)}`)}>{t("viviBot.supplement")}</Button>
    </div>
    {error ? <p role="alert" className="mt-2 wrap-anywhere text-sm text-destructive">{error}</p> : null}
  </Card>;
}
