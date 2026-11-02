import { useRef, useState, type JSX } from "react";
import { useTranslation } from "react-i18next";
import { HugeiconsIcon } from "@hugeicons/react";
import { AttachmentIcon, Cancel01Icon } from "@hugeicons/core-free-icons";
import { cn } from "@/lib/utils";
import { PROCESS_BODY_CAP } from "@/lib/process-body";
import { useTwoLineClamp } from "@/lib/use-two-line-clamp";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/icon-button";
import { ImagePreview } from "@/components/image-preview";
import type { ChatAttachment } from "@shared/types";

/**
 * An attached image is one `size-20` square (80px at the default 界面字号, rem so it
 * scales with it) in the composer and in a message alike. `object-cover` crops it to
 * that square, which is the honest trade for a thread that keeps every pasted screenshot
 * forever: at the old bounded-picture size one wide screenshot filled the first screen of
 * a chat and pushed the reply it belonged to out of view. The thumbnail only has to be
 * recognisable — the whole picture, uncropped, is one click away in the shared
 * lightbox. Other files keep their compact named chip.
 */
export function AttachmentChip({
  item,
  onRemove,
  onOpen,
  className,
}: {
  item: ChatAttachment;
  onRemove?: () => void;
  onOpen?: () => void;
  className?: string;
}): JSX.Element {
  const { t } = useTranslation("chat");
  const [previewOpen, setPreviewOpen] = useState(false);
  const textPreviewPinned = useRef(false);

  if (item.kind === "image" && item.dataUrl) {
    return (
      <span className={cn("group/attachment relative inline-flex max-w-full shrink-0 self-start", className)}>
        <Button
          type="button"
          variant="ghost"
          className="h-auto max-w-full cursor-zoom-in overflow-hidden rounded-xl border-border bg-muted/30 p-0"
          aria-label={item.name}
          aria-haspopup="dialog"
          onClick={() => {
            if (onOpen) onOpen();
            else setPreviewOpen(true);
          }}
        >
          <img src={item.dataUrl} alt={item.name} className="size-20 object-cover" />
        </Button>
        {onRemove ? (
          <IconButton
            type="button"
            variant="ghost"
            size="icon-xs"
            label={t("attach.remove", { name: item.name })}
            className="absolute -right-1.5 -top-1.5 z-10 rounded-full bg-foreground text-background opacity-0 shadow-sm ring-2 ring-background transition-opacity hover:bg-foreground/85 hover:text-background group-hover/attachment:opacity-100 group-focus-within/attachment:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-100"
            onClick={onRemove}
          >
            <HugeiconsIcon strokeWidth={2} icon={Cancel01Icon} className="size-3.5" />
          </IconButton>
        ) : null}
        <ImagePreview src={item.dataUrl} alt={item.name} open={previewOpen} onOpenChange={setPreviewOpen} />
      </span>
    );
  }

  const body = (
    <>
      <span className="flex size-6 items-center justify-center rounded-md bg-muted text-muted-foreground">
        <HugeiconsIcon strokeWidth={2} icon={AttachmentIcon} className="size-3.5" />
      </span>
      <span className="max-w-32 truncate">{item.name}</span>
      {onRemove ? (
        <button
          type="button"
          className="flex size-4 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted-foreground/20 hover:text-foreground"
          aria-label={t("attach.remove", { name: item.name })}
          onClick={onRemove}
        >
          <HugeiconsIcon strokeWidth={2} icon={Cancel01Icon} className="size-3" />
        </button>
      ) : null}
    </>
  );

  const shell = cn(
    "group/chip flex items-center gap-1.5 rounded-lg border border-border bg-muted/50 py-1 pl-1 pr-1.5 text-xs",
    onOpen && "text-left transition-colors hover:bg-muted",
    className,
  );

  // Pasted text has its own preview; a native title would stack a second popup over it.
  const title = item.text ? undefined : item.name;
  const chip = onOpen ? (
    <button type="button" className={shell} title={title} onClick={onOpen}>
      {body}
    </button>
  ) : (
    <span className={shell} title={title}>
      {body}
    </span>
  );

  if (!item.text) return chip;
  return (
    <HoverCard
      onOpenChange={(open, details) => {
        // Expanding can flip the popup to the other side of its chip, away from the
        // pointer. After an explicit interaction keep it open until outside press / Escape.
        if (!open && details.reason === "trigger-hover" && textPreviewPinned.current) {
          details.cancel();
        } else if (!open) {
          textPreviewPinned.current = false;
        }
      }}
    >
      <HoverCardTrigger render={chip} delay={300} />
      <HoverCardContent
        side="top"
        align="start"
        alignOffset={0}
        sideOffset={8}
        className="overlay-surface flex max-h-[var(--available-height)] w-md max-w-[min(28rem,calc(100vw-2rem),var(--available-width))] flex-col overflow-hidden rounded-xl p-0 shadow-none ring-0"
      >
        <div className="flex min-w-0 shrink-0 items-center gap-2 border-b border-border/60 px-4 py-3">
          <HugeiconsIcon icon={AttachmentIcon} strokeWidth={1.5} className="size-4 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1 truncate text-xs font-medium">{t("attach.pastedContent")}</span>
          <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
            {t("attach.characters", { count: item.text.length })}
          </span>
        </div>
        <PastedTextPreview text={item.text} onInteract={() => { textPreviewPinned.current = true; }} />
      </HoverCardContent>
    </HoverCard>
  );
}

// Mounted with the popup, so every new hover begins with a fresh two-line preview.
function PastedTextPreview({ text, onInteract }: { text: string; onInteract: () => void }): JSX.Element {
  const { t } = useTranslation("chat");
  const { expanded, setExpanded, overflows, bodyRef } = useTwoLineClamp(text);

  return (
    <div className="flex min-h-0 flex-col">
      <div
        data-process-body={expanded ? "" : undefined}
        className={cn(
          "min-h-0 overscroll-contain py-3 pl-4 pr-3",
          expanded ? PROCESS_BODY_CAP : "overflow-x-hidden overflow-y-hidden [scrollbar-gutter:stable]",
        )}
      >
        <div
          ref={bodyRef}
          className={cn(
            "whitespace-pre-wrap wrap-anywhere font-mono text-sm leading-6 text-popover-foreground/90",
            !expanded && "line-clamp-2",
          )}
        >
          {text}
        </div>
      </div>
      {overflows ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 w-full shrink-0 justify-start rounded-none px-4 text-xs font-normal text-muted-foreground hover:text-foreground"
          aria-expanded={expanded}
          onClick={() => {
            onInteract();
            setExpanded((value) => !value);
          }}
        >
          {expanded ? t("message.collapse") : t("message.expand")}
        </Button>
      ) : null}
    </div>
  );
}
