import { memo, useCallback, useEffect, useRef, useState, type JSX } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { ArrowRight01Icon, BrainIcon } from "@hugeicons/core-free-icons";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";

/** Fade length for the vertical scroll mask; zcode uses 24px. */
const MASK_FADE = 24;
/** The ticker is clipped at its right edge, so fade the last 16px. */
const TICKER_MASK = "linear-gradient(to right, black 0, black calc(100% - 16px), transparent 100%)";

/** Last non-empty line of the reasoning — the live ticker's content. */
function lastLine(text: string): { key: string; text: string } | null {
  const lines = text.replace(/\r\n?/gu, "\n").split("\n");
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]?.trim() ?? "";
    if (line.length > 0) return { key: String(index), text: line };
  }
  return null;
}

function secondsSince(startedAt: number): number {
  return Math.max(1, Math.ceil((Date.now() - startedAt) / 1000));
}

/**
 * Reasoning display, modelled on zcode's Reasoning / Trigger / Content trio.
 *
 * Collapsed by default: while the model thinks, the header carries a shimmering
 * 「正在思考」 and a rolling ticker of the newest line, so progress stays legible
 * without a wall of text. Once settled it reads 「思考 · 持续了 N 秒」 and the full
 * transcript stays one click away.
 */
export const ThinkingBlock = memo(function ThinkingBlock({
  thinking,
  active,
}: {
  thinking: string;
  active: boolean;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const [elapsed, setElapsed] = useState<number | null>(null);
  const startedAt = useRef<number | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const [mask, setMask] = useState({ top: false, bottom: false });

  // Timing only: start on the first active render, freeze the total when it ends.
  useEffect(() => {
    if (active) {
      startedAt.current ??= Date.now();
      setElapsed(secondsSince(startedAt.current));
      const timer = window.setInterval(() => {
        if (startedAt.current !== null) setElapsed(secondsSince(startedAt.current));
      }, 1000);
      return () => window.clearInterval(timer);
    }
    if (startedAt.current !== null) {
      setElapsed(secondsSince(startedAt.current));
      startedAt.current = null;
    }
    return undefined;
  }, [active]);

  // Fold the transcript away when the user did not open it themselves.
  const interacted = useRef(false);
  useEffect(() => {
    if (!active && !interacted.current) setOpen(false);
  }, [active]);

  const updateMask = useCallback((): void => {
    const node = bodyRef.current;
    if (!node) return;
    const overflow = Math.max(0, node.scrollHeight - node.clientHeight);
    const next =
      overflow <= 1 ? { top: false, bottom: false } : { top: node.scrollTop > 1, bottom: node.scrollTop < overflow - 1 };
    setMask((current) => (current.top === next.top && current.bottom === next.bottom ? current : next));
  }, []);

  // Follow the newest reasoning while it streams.
  useEffect(() => {
    if (!active || !open) return;
    const node = bodyRef.current;
    if (node) node.scrollTop = node.scrollHeight;
    updateMask();
  }, [thinking, active, open, updateMask]);

  // Recompute the fade when the body grows, scrolls, or the panel resizes.
  useEffect(() => {
    if (!open) return;
    const node = bodyRef.current;
    if (!node) return;
    updateMask();
    if (typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver(updateMask);
    observer.observe(node);
    return () => observer.disconnect();
  }, [open, updateMask]);

  const ticker = active && !open ? lastLine(thinking) : null;

  const bodyMask = mask.top || mask.bottom
    ? `linear-gradient(to bottom, ${
        mask.top ? `transparent 0px, black ${MASK_FADE}px` : `black 0px, black ${MASK_FADE}px`
      }, ${
        mask.bottom
          ? `black calc(100% - ${MASK_FADE}px), transparent 100%`
          : `black calc(100% - ${MASK_FADE}px), black 100%`
      })`
    : undefined;

  return (
    <Collapsible
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) interacted.current = true;
      }}
    >
      <CollapsibleTrigger
        className={cn(
          "group/reasoning inline-flex min-w-0 max-w-full cursor-pointer items-center gap-2 self-start",
          "text-left text-[12.5px] transition-colors",
          "rounded-sm focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
        )}
      >
        <HugeiconsIcon
          strokeWidth={2}
          icon={BrainIcon}
          className={cn("size-4 shrink-0", active ? "text-muted-foreground" : "text-muted-foreground/60")}
        />
        <span className="shrink-0 whitespace-nowrap">
          {active ? (
            <span className="animated-gradient-text font-medium">正在思考</span>
          ) : (
            <SettledLabel elapsed={elapsed} />
          )}
        </span>

        {ticker ? (
          <>
            <span className="shrink-0 text-muted-foreground/40">·</span>
            <span
              className="min-w-0 flex-1 overflow-hidden text-[11.5px] whitespace-nowrap text-muted-foreground/60"
              style={{ WebkitMaskImage: TICKER_MASK, maskImage: TICKER_MASK }}
            >
              <span key={ticker.key} className="reasoning-line inline-block">
                {ticker.text}
              </span>
            </span>
          </>
        ) : null}

        <HugeiconsIcon
          strokeWidth={2}
          aria-hidden
          icon={ArrowRight01Icon}
          className={cn(
            "size-4 shrink-0 text-muted-foreground/60 transition-all duration-200",
            "opacity-0 group-hover/reasoning:opacity-100",
            open && "rotate-90 opacity-100",
          )}
        />
      </CollapsibleTrigger>

      <CollapsibleContent>
        <div className="pt-3">
          <div
            ref={bodyRef}
            data-slot="reasoning-body"
            onScroll={updateMask}
            style={bodyMask ? { WebkitMaskImage: bodyMask, maskImage: bodyMask } : undefined}
            className={cn(
              "ml-2 max-h-60 overflow-auto border-l border-border pl-3.5",
              "text-[12px] leading-5 whitespace-pre-wrap break-words text-muted-foreground/80 select-text",
            )}
          >
            {thinking}
          </div>
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
});

/** 「思考 · 持续了 N 秒」; without a measured duration, just 「思考」. */
function SettledLabel({ elapsed }: { elapsed: number | null }): JSX.Element {
  if (elapsed === null) return <span className="font-medium text-muted-foreground">思考</span>;
  return (
    <span className="inline-flex items-center gap-2">
      <span className="font-medium text-muted-foreground">思考</span>
      <span className="font-normal text-muted-foreground/40">·</span>
      <span className="font-normal text-muted-foreground/60">持续了 {elapsed} 秒</span>
    </span>
  );
}
