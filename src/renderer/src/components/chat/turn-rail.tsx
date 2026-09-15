import { memo, useEffect, useRef, useState, type JSX } from "react";
import { useMessageScroller } from "@/components/ui/message-scroller";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

/**
 * A turn is one user prompt plus the reply it produced. The rail is the
 * transcript's table of contents: one mark per turn, pinned to the left gutter of
 * the scroll area (it does not scroll with the content), with the turn being read
 * highlighted. Hovering a mark previews the prompt and how the agent answered;
 * clicking rides the scroller back to that prompt.
 *
 * The rail only shows when the thread is wide enough to keep it out of the message
 * column (container query below); it never steals width from the transcript.
 */

export type TurnMarker = {
  /** Row id handed to `MessageScrollerItem` — the jump target. */
  id: string;
  /** Position of the prompt's row in the transcript: the viewport reports rows
   *  (prompts *and* replies), and this maps a row back to the turn that owns it. */
  rowIndex: number;
  /** Flattened user prompt, already clipped. */
  prompt: string;
  /** Flattened first lines of the reply, already clipped ("" while it streams). */
  reply: string;
};

/** Marks per density tier, keyed by how many turns have to fit in the rail. The
 *  hit area sets the spacing; the bar stays a thin line inside it. */
function densityOf(count: number): { hit: string; bar: string; gap: string } {
  if (count <= 24) return { hit: "h-2.5", bar: "h-0.5", gap: "gap-1" };
  if (count <= 44) return { hit: "h-2", bar: "h-0.5", gap: "gap-px" };
  if (count <= 88) return { hit: "h-1", bar: "h-0.5", gap: "gap-px" };
  // Below here the rail stops being a list and becomes a scale; the 1px gap keeps
  // the marks from merging into one solid line.
  if (count <= 220) return { hit: "h-0.5", bar: "h-0.5", gap: "gap-px" };
  if (count <= 500) return { hit: "h-px", bar: "h-px", gap: "gap-px" };
  return { hit: "h-px", bar: "h-px", gap: "gap-0" };
}

function sameMarkers(a: TurnMarker[], b: TurnMarker[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index += 1) {
    const left = a[index];
    const right = b[index];
    if (left.id !== right.id || left.prompt !== right.prompt || left.reply !== right.reply) return false;
  }
  return true;
}

/** Row ids only change when rows are added or removed, never on a streamed token. */
function sameRowIds(a: string[], b: string[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) return false;
  }
  return true;
}

function Tick({
  marker,
  index,
  active,
  hit,
  bar,
}: {
  marker: TurnMarker;
  index: number;
  active: boolean;
  hit: string;
  bar: string;
}): JSX.Element {
  const { scrollToMessage } = useMessageScroller();
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label={`第 ${index + 1} 轮 · ${marker.prompt}`}
            aria-current={active ? "true" : undefined}
            className={cn("group/tick flex w-6 items-center justify-start", hit)}
            onClick={(event) => {
              // Drop focus so the tooltip does not linger over the destination.
              event.currentTarget.blur();
              scrollToMessage(marker.id, { align: "start", behavior: "smooth" });
            }}
          />
        }
      >
        <span
          className={cn(
            // Short ticks that grow on hover: the rail reads as a quiet scale,
            // and only the turn you are on claims a longer line.
            "block rounded-full transition-[width,background-color] duration-150",
            bar,
            active ? "w-3.5 bg-foreground" : "w-2 bg-muted-foreground/35 group-hover/tick:w-3 group-hover/tick:bg-muted-foreground",
          )}
        />
      </TooltipTrigger>
      <TooltipContent
        side="right"
        align="center"
        sideOffset={10}
        className="w-80 max-w-80 flex-col items-stretch px-3 py-2.5"
      >
        <p className="line-clamp-2 text-[12.5px] leading-5 font-medium text-foreground">{marker.prompt}</p>
        {marker.reply ? (
          <p className="mt-1 line-clamp-3 text-[12px] leading-5 text-muted-foreground">{marker.reply}</p>
        ) : null}
      </TooltipContent>
    </Tooltip>
  );
}

export const TurnRail = memo(function TurnRail({
  markers,
  rowIds,
}: {
  markers: TurnMarker[];
  /** Every row id in transcript order — the viewport reports rows, not just
   *  prompts, so a reply at the top edge still resolves to its turn. */
  rowIds: string[];
}): JSX.Element {
  const navRef = useRef<HTMLElement | null>(null);
  const [active, setActive] = useState(-1);

  // The resolver reads these on every intersection change; keeping them in a ref
  // means the observer below survives a stream of new tokens.
  const latest = useRef({ markers, rowIds });
  useEffect(() => {
    latest.current = { markers, rowIds };
  });

  // Rows are only appended (or cleared on a conversation switch), so the length
  // and tail id describe the whole transcript shape.
  const rowKey = `${rowIds.length}:${rowIds.at(-1) ?? ""}`;

  useEffect(() => {
    const root = navRef.current?.closest('[data-slot="message-scroller"]');
    const viewport = root?.querySelector<HTMLElement>('[data-slot="message-scroller-viewport"]');
    if (!viewport || typeof IntersectionObserver === "undefined") return;

    const visible = new Set<string>();
    const resolve = (): void => {
      const { markers: turns, rowIds: rows } = latest.current;
      // The turn being read owns the topmost visible row: scrolling inside a long
      // reply keeps its prompt lit, and once the prompt itself scrolls away the
      // reply still points back at it.
      let topRow = Number.POSITIVE_INFINITY;
      for (const id of visible) {
        const index = rows.indexOf(id);
        if (index >= 0 && index < topRow) topRow = index;
      }
      if (topRow === Number.POSITIVE_INFINITY) return;
      let next = -1;
      for (let index = 0; index < turns.length; index += 1) {
        if (turns[index].rowIndex <= topRow) next = index;
        else break;
      }
      if (next >= 0) setActive(next);
    };

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const id = entry.target instanceof HTMLElement ? entry.target.dataset.messageId : undefined;
          if (!id) continue;
          if (entry.isIntersecting) visible.add(id);
          else visible.delete(id);
        }
        resolve();
      },
      // Matches the scroller's own "at the top edge" margin, so the highlight
      // flips when a row actually reaches the reading position.
      { root: viewport, rootMargin: "-64px 0px 0px 0px" },
    );
    viewport.querySelectorAll<HTMLElement>("[data-message-id]").forEach((element) => observer.observe(element));
    return () => observer.disconnect();
    // `rowKey` is the transcript's shape; the ref carries the rest.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rowKey]);

  const { hit, bar, gap } = densityOf(markers.length);

  return (
    <nav
      ref={navRef}
      aria-label="轮次导航"
      className="pointer-events-none absolute inset-y-0 left-0 z-20 hidden w-9 flex-col justify-center @min-[58rem]/thread:flex"
    >
      <div className={cn("pointer-events-auto flex max-h-[86%] flex-col items-start overflow-hidden py-1 pl-2.5", gap)}>
        {markers.map((marker, index) => (
          <Tick key={marker.id} marker={marker} index={index} active={index === active} hit={hit} bar={bar} />
        ))}
      </div>
    </nav>
  );
}, (prev, next) => sameMarkers(prev.markers, next.markers) && sameRowIds(prev.rowIds, next.rowIds));
