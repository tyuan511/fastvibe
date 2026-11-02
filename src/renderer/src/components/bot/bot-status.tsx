import type { JSX } from "react";
import { useTranslation } from "react-i18next";
import { HugeiconsIcon } from "@hugeicons/react";
import { AlertCircleIcon, CheckmarkCircle02Icon, MessageQuestionIcon, PauseIcon } from "@hugeicons/core-free-icons";
import { RunningMark } from "@/components/running-mark";
import { cn } from "@/lib/utils";
import type { BotConversationMeta, BotResultStatus } from "@shared/bot";

export function folderName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

export function resultTone(status: BotResultStatus): string {
  return status === "failed" ? "text-destructive" : status === "ready" ? "text-success" : status === "blocked" ? "text-warning" : "text-muted-foreground";
}

export function ConversationStatusIcon({ running, waiting, paused, className }: { running?: boolean; waiting?: boolean; paused?: boolean; className?: string }): JSX.Element {
  const icon = waiting ? MessageQuestionIcon : paused ? PauseIcon : AlertCircleIcon;
  return <span className={cn("flex size-4 shrink-0 items-center justify-center", className)}>{running ? <RunningMark className="text-primary" /> : <HugeiconsIcon strokeWidth={2} icon={icon} className={cn("size-3.5", waiting ? "text-warning" : paused ? "text-muted-foreground" : "text-muted-foreground")} />}</span>;
}

export function ConversationRow({ conversation, running, waiting, onOpen }: { conversation: BotConversationMeta; running?: boolean; waiting?: boolean; onOpen: (conversation: BotConversationMeta) => void }): JSX.Element {
  const { t } = useTranslation("sidepane");
  return <button type="button" title={conversation.title || conversation.conversationId} onClick={() => onOpen(conversation)} className="group/conversation flex w-full min-w-0 items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
    <ConversationStatusIcon running={running} waiting={waiting} paused={conversation.paused} />
    <span className="min-w-0 flex-1 truncate text-sm">{conversation.title || conversation.conversationId}</span>
    <span className="hidden max-w-32 shrink-0 truncate text-xs text-muted-foreground @min-[28rem]/tray:inline">{conversation.project ? folderName(conversation.project) : t("bot.workspace")}</span>
  </button>;
}

export function ResultStatus({ status }: { status: BotResultStatus }): JSX.Element {
  const { t } = useTranslation("app");
  const icon = status === "ready" ? CheckmarkCircle02Icon : AlertCircleIcon;
  return <span className={cn("inline-flex items-center gap-1 text-xs", resultTone(status))}><HugeiconsIcon strokeWidth={2} icon={icon} className="size-3.5" />{t(`viviBot.resultStatus.${status}`, status)}</span>;
}
