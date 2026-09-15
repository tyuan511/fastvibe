import type { JSX } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { AttachmentIcon, Cancel01Icon } from "@hugeicons/core-free-icons";
import { cn } from "@/lib/utils";
import type { ChatAttachment } from "@shared/types";

/**
 * The one attachment representation the app uses — a compact chip with a 24px
 * thumbnail (images) or file glyph, the truncated name, and an optional remove
 * button. The composer renders it while composing; sent messages render the same
 * chip above the user bubble so a reference image never blows up to full size.
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
  const body = (
    <>
      {item.kind === "image" && item.dataUrl ? (
        <img src={item.dataUrl} alt="" className="size-6 rounded-md object-cover" />
      ) : (
        <span className="flex size-6 items-center justify-center rounded-md bg-muted text-muted-foreground">
          <HugeiconsIcon strokeWidth={2} icon={AttachmentIcon} className="size-3.5" />
        </span>
      )}
      <span className="max-w-32 truncate">{item.name}</span>
      {onRemove ? (
        <button
          type="button"
          className="flex size-4 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted-foreground/20 hover:text-foreground"
          aria-label={`移除 ${item.name}`}
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

  if (onOpen) {
    return (
      <button type="button" className={shell} title={item.name} onClick={onOpen}>
        {body}
      </button>
    );
  }

  return (
    <span className={shell} title={item.name}>
      {body}
    </span>
  );
}
