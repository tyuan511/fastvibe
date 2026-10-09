import { useEffect, useState, type JSX, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { HugeiconsIcon } from "@hugeicons/react";
import { ArrowRight01Icon } from "@hugeicons/core-free-icons";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { formatDuration } from "@/lib/time";
import { cn } from "@/lib/utils";

function RunHeader({ children }: { children: ReactNode }): JSX.Element {
  return (
    <div className="flex w-full max-w-2xl items-center border-b border-border pt-2 pb-2">
      {children}
    </div>
  );
}

/** A live run shares the fold header's layout, with no interactive control. */
export function RunProgress({ startedAt }: { startedAt: number }): JSX.Element {
  const { t } = useTranslation("chat");
  const [now, setNow] = useState(() => Date.now());

  // Keep the clock local to the header so each tick does not re-render the transcript.
  useEffect(() => {
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [startedAt]);

  return (
    <RunHeader>
      <span data-slot="run-progress" role="timer" className="truncate text-sm text-muted-foreground tabular-nums">
        {t("run.processing", { duration: formatDuration(Math.max(0, now - startedAt)) })}
      </span>
    </RunHeader>
  );
}

/**
 * 折叠运行过程: a finished run's work — thinking, tool calls, and the prose it wrote along
 * the way — behind one collapsed 「用时 1 分钟 24 秒」 row, with the reply that followed the
 * last tool call left out as the answer.
 *
 * Only ever rendered for a run that has settled *and* wrote an answer, so the block is always
 * something the reader can open and close, and it always has both halves: work to hide and an
 * answer left on screen. A run still in flight uses RunProgress above its unfolded transcript.
 */
export function RunCollapse({
  durationMs,
  children,
}: {
  /** How long the run took: its first request start to the instant it finished. */
  durationMs: number;
  children: ReactNode;
}): JSX.Element {
  const { t } = useTranslation("chat");
  const [open, setOpen] = useState(false);

  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      // MessageContent is `items-start`, so without an explicit width the header shrinks to
      // the label and its rule reads as a short chip instead of the transcript's full width.
      className="flex w-full max-w-2xl flex-col"
    >
      <RunHeader>
        <CollapsibleTrigger
          data-slot="run-collapse"
          className={cn(
            "group/run inline-flex max-w-full cursor-pointer items-center gap-1.5 text-left text-sm",
            "rounded-none text-muted-foreground transition-colors hover:text-foreground",
            "focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
          )}
        >
          <span className="truncate">{t("run.duration", { duration: formatDuration(durationMs) })}</span>
          <HugeiconsIcon
            strokeWidth={2}
            aria-hidden
            icon={ArrowRight01Icon}
            className={cn(
              "size-3.5 shrink-0 text-muted-foreground/60 transition-transform duration-200",
              open && "rotate-90",
            )}
          />
        </CollapsibleTrigger>
      </RunHeader>
      <CollapsibleContent>
        <div className="flex flex-col gap-2.5 pt-3">{children}</div>
      </CollapsibleContent>
    </Collapsible>
  );
}
