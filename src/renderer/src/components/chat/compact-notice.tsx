import { useState, type JSX } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { ArrowRight01Icon, ScissorIcon } from "@hugeicons/core-free-icons";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import type { ChatMessage, CompactReason } from "@shared/types";
import { MarkdownView } from "./markdown-view";

const REASON_LABEL: Partial<Record<CompactReason, string>> = {
  threshold: "接近上限",
  overflow: "超出窗口",
};

/** Compact `45.5K` / `1.2M` counts, matching the composer's context ring. */
function formatCount(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return String(Math.round(value));
}

function tokenHint(before?: number, after?: number): string | null {
  if (before != null && after != null) return `${formatCount(before)} → ${formatCount(after)}`;
  if (before != null) return formatCount(before);
  return null;
}

/**
 * Compaction card in the transcript: a thinking-block-like collapsible so a
 * running compact is visible, and the summary is one click away once it lands.
 */
export function CompactNotice({ message }: { message: ChatMessage }): JSX.Element {
  const [open, setOpen] = useState(false);
  const info = message.compact;
  const status = info?.status ?? (message.text ? "done" : "running");
  const running = status === "running";
  const summary = status === "done" ? message.text.trim() : "";
  const reason = info?.reason ? REASON_LABEL[info.reason] : undefined;
  const tokens = tokenHint(info?.tokensBefore, info?.tokensAfter);
  const error = status === "error" ? (info?.error || message.text || "压缩失败") : null;
  const expandable = Boolean(summary);

  const label =
    running ? (
      <span className="animated-gradient-text font-medium">正在压缩上下文</span>
    ) : status === "aborted" ? (
      <span className="font-medium text-muted-foreground">上下文压缩已取消</span>
    ) : status === "error" ? (
      <span className="font-medium text-destructive">压缩失败</span>
    ) : (
      <span className="font-medium text-muted-foreground">上下文已压缩</span>
    );

  const header = (
    <span className="inline-flex min-w-0 max-w-full items-center gap-2 text-sm">
      {running ? (
        <Spinner className="size-4 text-muted-foreground" />
      ) : (
        <HugeiconsIcon strokeWidth={2} icon={ScissorIcon} className="size-4 shrink-0 text-muted-foreground" />
      )}
      <span className="shrink-0 whitespace-nowrap">{label}</span>
      {reason || tokens ? (
        <>
          <span className="shrink-0 text-muted-foreground/40">·</span>
          <span className="min-w-0 truncate text-muted-foreground/60">
            {[reason, tokens].filter(Boolean).join(" · ")}
          </span>
        </>
      ) : null}
      {expandable ? (
        <HugeiconsIcon
          strokeWidth={2}
          aria-hidden
          icon={ArrowRight01Icon}
          className={cn(
            "size-4 shrink-0 text-muted-foreground/60 transition-all duration-200",
            "opacity-0 group-hover/compact:opacity-100",
            open && "rotate-90 opacity-100",
          )}
        />
      ) : null}
    </span>
  );

  if (!expandable) {
    return (
      <div className="flex flex-col gap-1">
        {header}
        {error ? <p className="pl-6 text-sm text-destructive">{error}</p> : null}
      </div>
    );
  }

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger
        className={cn(
          "group/compact inline-flex min-w-0 max-w-full cursor-pointer items-center self-start",
          "text-left transition-colors",
          "rounded-sm focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
        )}
      >
        {header}
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="pt-3">
          <div className="ml-2 max-h-60 overflow-auto border-l border-border pl-3.5 text-sm leading-5 text-muted-foreground/80">
            <MarkdownView text={summary} />
          </div>
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
