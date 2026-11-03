import type { JSX } from "react";
import { useTranslation } from "react-i18next";
import { HugeiconsIcon } from "@hugeicons/react";
import { AlertCircleIcon, CheckmarkCircle02Icon, Clock01Icon, MessageQuestionIcon, PauseIcon } from "@hugeicons/core-free-icons";
import { BotConversationAvatar } from "./bot-conversation-avatar";
import { RunningMark } from "@/components/running-mark";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { formatRelativeTime } from "@/lib/time";
import { cn } from "@/lib/utils";
import type { BotConversationCardData, BotConversationCardStatus } from "@/lib/bot-conversation-card";
import type { BotConversationMeta, BotResultStatus } from "@shared/bot";

export function folderName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

export function resultTone(status: BotResultStatus): string {
  return status === "failed" ? "text-destructive" : status === "ready" ? "text-success" : status === "blocked" ? "text-warning" : "text-muted-foreground";
}

function statusTone(status: BotConversationCardStatus): string {
  if (status === "working") return "text-primary";
  if (status === "waiting" || status === "blocked" || status === "unconfirmed") return "text-warning";
  if (status === "completed") return "text-success";
  if (status === "failed") return "text-destructive";
  return "text-muted-foreground";
}

function CardStatusIcon({ status }: { status: BotConversationCardStatus }): JSX.Element {
  if (status === "working") return <RunningMark className="size-3" />;
  const icon = status === "completed" ? CheckmarkCircle02Icon
    : status === "waiting" || status === "blocked" ? MessageQuestionIcon
      : status === "paused" || status === "interrupted" ? PauseIcon
        : status === "failed" || status === "unconfirmed" ? AlertCircleIcon : Clock01Icon;
  return <HugeiconsIcon strokeWidth={2} icon={icon} className="size-3" />;
}

export function ConversationCard({ item, onOpen }: { item: BotConversationCardData; onOpen: (conversation: BotConversationMeta) => void }): JSX.Element {
  const { t } = useTranslation("sidepane");
  const { conversation, preview, status, updatedAt } = item;
  const title = conversation.title || conversation.conversationId;
  return <Card size="sm" className="gap-0 py-0 transition-colors hover:ring-foreground/20">
    <Button variant="ghost" onClick={() => onOpen(conversation)} className="h-auto w-full min-w-0 flex-col items-stretch gap-2 rounded-xl p-2.5 text-left whitespace-normal hover:bg-muted/40" aria-label={title}>
      <span className="flex min-w-0 items-center gap-2">
        <BotConversationAvatar status={status} />
        <span className="min-w-0 flex-1 line-clamp-2 wrap-anywhere text-sm font-medium leading-5">{title}</span>
      </span>
      <span className={cn("min-h-10 line-clamp-2 wrap-anywhere text-sm font-normal leading-5", preview ? "text-foreground/75" : "text-muted-foreground")}>{preview || t("bot.noReply")}</span>
      <span className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <Badge variant="secondary" className={cn("gap-1.5 bg-muted/60 font-normal", statusTone(status))}>
          <CardStatusIcon status={status} />{t(`bot.cardStatus.${status}`)}
        </Badge>
        <time dateTime={new Date(updatedAt).toISOString()} title={new Date(updatedAt).toLocaleString()} className="text-xs font-normal text-muted-foreground">{t("app:viviBot.updatedAt", { time: formatRelativeTime(updatedAt) })}</time>
      </span>
    </Button>
  </Card>;
}
