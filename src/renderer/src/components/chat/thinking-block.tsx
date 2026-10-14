import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState, type JSX } from "react";
import { useTranslation } from "react-i18next";
import { HugeiconsIcon } from "@hugeicons/react";
import { ArrowRight01Icon, BrainIcon } from "@hugeicons/core-free-icons";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";

/** Fade length for the vertical scroll mask; zcode uses 24px. */
const MASK_FADE = 24;
/** Left fade once the one-line ticker has scrolled, so the cut is not a hard edge. */
const TICKER_FADE = "linear-gradient(to right, transparent 0, black 16px, black 100%)";
/** A few characters may slide in; a burst snaps so a fast stream never hides the tail. */
const TICKER_SLIDE_MAX = 72;

/**
 * The collapsed live preview is one line of everything written so far, not the
 * newest source line. A per-line entrance restarts on every newline, and a fast
 * stream cuts that slide off before it finishes — the row then shows only a
 * fragment. Collapsing whitespace keeps the preview one line; the expanded body
 * still renders the original breaks.
 */
function tickerLine(text: string): string | null {
  const line = text.replace(/\s+/gu, " ").trim();
  return line.length > 0 ? line : null;
}

function secondsSince(startedAt: number, endedAt: number): number {
  return Math.max(1, Math.ceil((endedAt - startedAt) / 1000));
}

/**
 * Reasoning display, modelled on zcode's Reasoning / Trigger / Content trio.
 *
 * Collapsed by default: while the model thinks, the header carries a shimmering
 * 「正在思考」 and a single line that keeps growing at its right edge, so a fast
 * stream stays a full row of the latest text instead of a clipped entrance.
 * Once settled it reads 「思考 · N 秒」 and the full transcript stays one click away.
 *
 * The elapsed time is derived from the bounds Main measured (`startedAt` / `endedAt`)
 * rather than counted here, so it survives a remount — session switch, `agent_end`
 * reload, app restart — and an open block keeps counting from its real start.
 */
export const ThinkingBlock = memo(function ThinkingBlock({
  thinking,
  startedAt,
  endedAt,
  active,
}: {
  thinking: string;
  startedAt?: number;
  endedAt?: number;
  active: boolean;
}): JSX.Element {
  const { t } = useTranslation("chat");
  const [open, setOpen] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const bodyRef = useRef<HTMLDivElement>(null);
  const [mask, setMask] = useState({ top: false, bottom: false });

  // Re-read the clock once a second while the block is open and on screen; a closed
  // block is a function of its bounds and needs no timer. Gating on `active` also
  // freezes a block whose end never arrived (a turn cut off mid-thought) instead of
  // letting it tick up forever.
  useEffect(() => {
    if (!active || startedAt === undefined || endedAt !== undefined) return undefined;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [active, startedAt, endedAt]);

  const elapsed = startedAt === undefined ? null : secondsSince(startedAt, endedAt ?? now);

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

  const ticker = active && !open ? tickerLine(thinking) : null;

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
      className="w-full min-w-0"
    >
      <CollapsibleTrigger
        className={cn(
          "group/reasoning min-w-0 max-w-full cursor-pointer items-center gap-2 self-start",
          "text-left text-sm transition-colors",
          "rounded-sm focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
          // A live preview needs a bounded one-line track. `flex` and `inline-flex`
          // both set display, so only one may be present.
          ticker ? "flex w-full" : "inline-flex",
        )}
      >
        <HugeiconsIcon
          strokeWidth={2}
          icon={BrainIcon}
          className={cn("size-4 shrink-0 text-muted-foreground")}
        />
        <span className="shrink-0 whitespace-nowrap">
          {active ? (
            <span className="animated-gradient-text font-normal">{t("thinking.running")}</span>
          ) : (
            <SettledLabel elapsed={elapsed} />
          )}
        </span>

        {ticker ? <ReasoningTicker text={ticker} /> : null}

        <HugeiconsIcon
          strokeWidth={2}
          aria-hidden
          icon={ArrowRight01Icon}
          className={cn(
            "size-4 shrink-0 text-muted-foreground/60 transition-all duration-200",
            "opacity-0 group-hover/reasoning:opacity-100 pointer-coarse:opacity-100",
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
              "text-sm leading-5 whitespace-pre-wrap break-words text-muted-foreground/80 select-text",
            )}
          >
            {thinking}
          </div>
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
});

/**
 * One line, growing at the right. The window follows the tail, so a fast stream
 * keeps a full row of the latest text on screen instead of restarting an entrance
 * on each newline. A short slide covers a few new characters; a burst snaps.
 */
function ReasoningTicker({ text }: { text: string }): JSX.Element {
  const frameRef = useRef<HTMLSpanElement>(null);
  const trackRef = useRef<HTMLSpanElement>(null);
  const shiftRef = useRef(0);
  const [shift, setShift] = useState(0);
  const [slide, setSlide] = useState(false);

  const follow = useCallback((allowSlide: boolean): void => {
    const frame = frameRef.current;
    const track = trackRef.current;
    if (!frame || !track || frame.clientWidth <= 0) return;
    const overflow = track.scrollWidth - frame.clientWidth;
    const next = overflow > 1 ? -overflow : 0;
    const delta = Math.abs(next - shiftRef.current);
    shiftRef.current = next;
    setSlide(allowSlide && delta > 0.5 && delta <= TICKER_SLIDE_MAX);
    setShift((current) => (Math.abs(current - next) < 0.5 ? current : next));
  }, []);

  useLayoutEffect(() => {
    follow(true);
  }, [text, follow]);

  useEffect(() => {
    const frame = frameRef.current;
    if (!frame || typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver(() => follow(false));
    observer.observe(frame);
    return () => observer.disconnect();
  }, [follow]);

  return (
    <>
      <span aria-hidden className="shrink-0 text-muted-foreground/40">
        ·
      </span>
      <span
        ref={frameRef}
        aria-hidden
        className="min-w-0 shrink overflow-hidden text-sm whitespace-nowrap text-muted-foreground/60"
        style={shift < 0 ? { WebkitMaskImage: TICKER_FADE, maskImage: TICKER_FADE } : undefined}
      >
        <span
          ref={trackRef}
          data-slide={slide ? "1" : undefined}
          className="reasoning-ticker inline-block whitespace-nowrap"
          style={shift ? { transform: `translate3d(${shift}px,0,0)` } : undefined}
        >
          {text}
        </span>
      </span>
    </>
  );
}

/** 「思考 · N 秒」; without a measured duration, just 「思考」. */
function SettledLabel({ elapsed }: { elapsed: number | null }): JSX.Element {
  const { t } = useTranslation("chat");
  if (elapsed === null) return <span className="font-normal text-muted-foreground">{t("thinking.done")}</span>;
  return (
    <span className="inline-flex items-center gap-2">
      <span className="font-normal text-muted-foreground">{t("thinking.done")}</span>
      <span className="font-normal text-muted-foreground/40">·</span>
      <span className="font-normal text-muted-foreground/60">{t("thinking.seconds", { n: elapsed })}</span>
    </span>
  );
}
