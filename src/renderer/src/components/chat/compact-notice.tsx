import type { JSX } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import type { ChatMessage } from "@shared/types";



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
 * Compaction divider. Same quiet rule as a model switch: it sits between turns,
 * never inside the reply it followed. While it runs the label flickers; once the
 * summary has landed the same rule just says it is done.
 */
export function CompactNotice({ message }: { message: Pick<ChatMessage, "text" | "compact"> }): JSX.Element {
  const { t } = useTranslation("chat");
  const info = message.compact;
  const status = info?.status ?? (message.text ? "done" : "running");
  const running = status === "running";
  const reason = info?.reason === "threshold" || info?.reason === "overflow" ? t(`compact.${info.reason}`) : undefined;
  const tokens = tokenHint(info?.tokensBefore, info?.tokensAfter);
  const error = status === "error" ? (info?.error || message.text || t("compact.failed")) : null;
  const detail = [reason, tokens].filter(Boolean).join(" · ");
  const label = running
    ? t("compact.running")
    : status === "aborted"
      ? t("compact.cancelled")
      : status === "error"
        ? t("compact.failed")
        : t("compact.done");

  return (
    <div className="flex w-full flex-col gap-1 py-1">
      <div className="flex w-full items-center gap-3 text-xs text-muted-foreground/60">
        <span aria-hidden className="h-px min-w-4 flex-1 bg-border" />
        <span className="flex min-w-0 items-center gap-1.5">
          <span
            className={cn(
              "shrink-0",
              running && "animated-gradient-text animated-gradient-text-emphasis compact-running-label font-medium",
              status === "error" && "font-medium text-destructive",
            )}
          >
            {label}
          </span>
          {detail ? (
            <>
              <span className="shrink-0 text-muted-foreground/40">·</span>
              <span className="min-w-0 truncate font-medium text-muted-foreground/80">{detail}</span>
            </>
          ) : null}
        </span>
        <span aria-hidden className="h-px min-w-4 flex-1 bg-border" />
      </div>
      {error ? <p className="text-center text-xs text-destructive">{error}</p> : null}
    </div>
  );
}
