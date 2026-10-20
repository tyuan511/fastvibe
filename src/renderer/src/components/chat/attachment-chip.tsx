import { useState, type JSX } from "react";
import { useTranslation } from "react-i18next";
import { HugeiconsIcon } from "@hugeicons/react";
import { AttachmentIcon, Cancel01Icon } from "@hugeicons/core-free-icons";
import { cn } from "@/lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/icon-button";
import { ImagePreview } from "@/components/image-preview";
import type { ChatAttachment } from "@shared/types";

/**
 * Images are thumbnails in the composer and bounded, uncropped pictures in a
 * message. Both open the shared lightbox. Other files keep their compact named chip.
 */
export function AttachmentChip({
  item,
  onRemove,
  onOpen,
  variant = "composer",
  className,
}: {
  item: ChatAttachment;
  onRemove?: () => void;
  onOpen?: () => void;
  variant?: "composer" | "message";
  className?: string;
}): JSX.Element {
  const { t } = useTranslation("chat");
  const [previewOpen, setPreviewOpen] = useState(false);

  if (item.kind === "image" && item.dataUrl) {
    return (
      <span className={cn("group/attachment relative inline-flex shrink-0 self-start", variant === "message" ? "max-w-[min(20rem,100%)]" : "max-w-full", className)}>
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
          <img
            src={item.dataUrl}
            alt={item.name}
            className={variant === "composer" ? "size-28 object-cover" : "block h-auto max-h-72 w-auto max-w-full object-contain"}
          />
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

  const content = item.text ?? item.name;
  const chip = onOpen ? (
    <button type="button" className={shell} title={content} onClick={onOpen}>
      {body}
    </button>
  ) : (
    <span className={shell} title={content}>
      {body}
    </span>
  );

  if (!item.text) return chip;
  return (
    <Tooltip>
      <TooltipTrigger render={chip} />
      <TooltipContent side="top" align="start" className="max-h-64 max-w-96 overflow-auto">
        <div className="whitespace-pre-wrap break-words text-sm">{item.text}</div>
      </TooltipContent>
    </Tooltip>
  );
}
