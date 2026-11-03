import { memo, type JSX } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { HugeiconsIcon } from "@hugeicons/react";
import { Copy01Icon } from "@hugeicons/core-free-icons";
import { Bubble, BubbleContent } from "@/components/ui/bubble";
import { Message, MessageContent } from "@/components/ui/message";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from "@/components/ui/context-menu";
import { IconButton } from "@/components/icon-button";
import { FastVibeMascot, type FastVibeMascotPalette } from "@/components/fastvibe-mascot";
import { AttachmentChip } from "@/components/chat/attachment-chip";
import { MarkdownView } from "@/components/chat/markdown-view";
import { SkillBadge } from "@/components/chat/skill-badge";
import { stripAttachmentBlock } from "@/lib/attachments";
import { useSessionStore } from "@/stores/session";
import { cn } from "@/lib/utils";
import { ViviChatRow } from "./vivi-chat-row";
import type { ChatMessage } from "@shared/types";

/** A feed message stays a message: no prompt clamp, execution footer or turn merging. */
export const ViviMessageRow = memo(function ViviMessageRow({ message, groupStart, palette, timestamp }: {
  message: ChatMessage;
  groupStart: boolean;
  palette: FastVibeMascotPalette;
  timestamp: string;
}): JSX.Element {
  const { t } = useTranslation("chat");
  const isUser = message.role === "user";
  const text = isUser ? stripAttachmentBlock(message.text) : message.text;
  const special = message.role === "system";
  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(text);
      toast.success(t("message.copied"));
    } catch { /* The selectable message remains available if the clipboard is unavailable. */ }
  };

  return (
    <Message align={isUser ? "end" : "start"} role="group" aria-label={t("app:viviBot.chat.sender", { name: isUser ? t("app:viviBot.chat.you") : "Vivi", time: timestamp })} title={timestamp} data-slot="vivi-message" data-message-role={message.role} className="group/vivi-message items-start gap-2.5">
      {!isUser ? (
        <div aria-hidden className="flex size-8 shrink-0 items-center justify-center rounded-full">
          {groupStart ? <FastVibeMascot size="size-8" palette={palette} motion={false} /> : null}
        </div>
      ) : null}
      <MessageContent className={cn("w-fit max-w-[calc(100%-4.375rem)] gap-1.5", isUser ? "items-end" : "items-start")}>
        {message.attachments?.length ? (
          <div className={cn("flex max-w-full flex-wrap gap-2", isUser && "justify-end")}>
            {message.attachments.map((item) => (
              <AttachmentChip key={item.id} item={item} onOpen={item.kind !== "image" && item.path
                ? () => { void useSessionStore.getState().openPreview(item.path!); }
                : undefined} />
            ))}
          </div>
        ) : null}
        {message.skill ? <SkillBadge skill={message.skill} /> : null}
        {text || message.error ? (
          <ContextMenu>
            <ContextMenuTrigger render={<div className="group/vivi-bubble relative min-w-0 max-w-full" title={timestamp} />}>
              <Bubble variant="secondary" align={isUser ? "end" : "start"} className={cn(
                "max-w-full",
                isUser && "*:data-[slot=bubble-content]:bg-vivi-user-bubble *:data-[slot=bubble-content]:text-vivi-user-bubble-foreground",
              )}>
                <BubbleContent className={cn(
                  "select-text rounded-2xl px-3.5 py-2.5 text-sm leading-6 wrap-anywhere",
                  groupStart && (isUser ? "rounded-tr-md" : "rounded-tl-md"),
                )}>
                  {special ? <ViviChatRow message={message} /> : isUser
                    ? <div className="whitespace-pre-wrap wrap-anywhere">{text}</div>
                    : <div className="chat-markdown wrap-anywhere"><MarkdownView text={text} /></div>}
                </BubbleContent>
              </Bubble>
              {text ? <IconButton
                type="button" size="icon-xs" variant="ghost" label={t("message.copy")}
                className={cn(
                  "absolute top-1.5 rounded-full bg-background/90 text-muted-foreground opacity-0 transition-opacity group-hover/vivi-bubble:opacity-100 group-focus-within/vivi-bubble:opacity-100 pointer-coarse:static pointer-coarse:mt-1 pointer-coarse:opacity-100",
                  isUser ? "-left-7" : "-right-7",
                )}
                onClick={() => void copy()}
              ><HugeiconsIcon icon={Copy01Icon} strokeWidth={2} className="size-3" /></IconButton> : null}
            </ContextMenuTrigger>
            <ContextMenuContent>
              {text ? <ContextMenuItem onClick={() => void copy()}>{t("message.copy")}</ContextMenuItem> : null}
              <div className="px-2 py-1.5 text-xs tabular-nums text-muted-foreground">{timestamp}</div>
            </ContextMenuContent>
          </ContextMenu>
        ) : null}
      </MessageContent>
    </Message>
  );
});
