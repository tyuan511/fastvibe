import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type JSX,
  type MutableRefObject,
} from "react";
import { motion, useMotionValue, useReducedMotion, useSpring, useTransform, type MotionValue } from "motion/react";
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

/**
 * Dock magnification.
 *
 * Hovering the rail grows the ticks near the pointer the way the macOS Dock grows
 * its icons: the tick under the cursor is full length and its neighbours taper off
 * with distance. A tick's length is a pure function of how far the cursor is along
 * the rail — not of which tick happens to be hovered — so the lens follows the
 * pointer instead of snapping between marks.
 */
const DOCK = {
  /** Length at rest, and under the pointer. */
  rest: 8,
  full: 30,
  /** Rested length of the current turn's tick, a little longer than the rest. */
  activeRest: 14,
  /** Ticks within this many px of the pointer grow at all. */
  reach: 90,
  /** Falloff: 1 at the pointer, 0 at `reach`. Higher = tighter spotlight. */
  falloff: 2,
  /** Pointer follow: stiff enough to feel attached, springy enough to float. */
  follow: { stiffness: 520, damping: 34, mass: 0.7 },
  /** Rest-to-magnified blend on hover in/out. */
  hover: { stiffness: 320, damping: 30 },
} as const;

/** Gutter that holds the longest tick plus its left padding. The nav is always
 *  this wide, so hovering never shifts the transcript or reflows the marks. */
const RAIL_WIDTH = 44;

/** A tick's length in px for a pointer that many px away along the rail. */
function dockWidth(distance: number, base: number): number {
  if (distance >= DOCK.reach) return base;
  const t = 1 - distance / DOCK.reach;
  const eased = Math.pow(t, DOCK.falloff);
  return base + (DOCK.full - base) * eased;
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
  pointerY,
  hover,
  centers,
  tickRef,
}: {
  marker: TurnMarker;
  index: number;
  active: boolean;
  hit: string;
  bar: string;
  /** Smoothed pointer position down the rail, in viewport px. */
  pointerY: MotionValue<number>;
  /** 0 at rest, 1 while the rail is hovered. */
  hover: MotionValue<number>;
  /** Measured tick centres, shared with the rail so nothing measures per frame. */
  centers: MutableRefObject<number[]>;
  tickRef: (element: HTMLButtonElement | null) => void;
}): JSX.Element {
  const { scrollToMessage } = useMessageScroller();

  // Length is a function of the pointer's distance from this tick's centre. Both
  // motion values are read inside so motion re-runs this on every frame without a
  // React render; the centre comes from the rail's cached layout measurement.
  const width = useTransform(() => {
    const base = active ? DOCK.activeRest : DOCK.rest;
    const y = pointerY.get();
    const distance = Math.abs(y - (centers.current[index] ?? 0));
    return base + (dockWidth(distance, base) - base) * hover.get();
  });

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            ref={tickRef}
            type="button"
            aria-label={`第 ${index + 1} 轮 · ${marker.prompt}`}
            aria-current={active ? "true" : undefined}
            className={cn("group/tick flex w-full items-center justify-start", hit)}
            onClick={(event) => {
              // Drop focus so the tooltip does not linger over the destination.
              event.currentTarget.blur();
              scrollToMessage(marker.id, { align: "start", behavior: "smooth" });
            }}
          />
        }
      >
        <motion.span
          className={cn(
            // The rail is a quiet scale at rest; the dock grows the ticks near the
            // pointer. Width is a motion value, so no CSS width transition here.
            "block rounded-full",
            bar,
            active ? "bg-foreground" : "bg-muted-foreground/35 group-hover/tick:bg-muted-foreground",
          )}
          style={{ width }}
        />
      </TooltipTrigger>
      <TooltipContent
        side="right"
        align="center"
        sideOffset={10}
        className="w-80 max-w-80 flex-col items-stretch px-3 py-2.5"
      >
        <p className="line-clamp-2 text-xs leading-5 font-medium text-foreground">{marker.prompt}</p>
        {marker.reply ? (
          <p className="mt-1 line-clamp-3 text-xs leading-5 text-muted-foreground">{marker.reply}</p>
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

  // Raw pointer position, then a spring on top so a tick's length eases toward the
  // cursor instead of tracking it rigidly; reset to the rail's centre on leave.
  const pointerY = useMotionValue(0);
  const smoothY = useSpring(pointerY, DOCK.follow);
  const hoverRaw = useMotionValue(0);
  const hover = useSpring(hoverRaw, DOCK.hover);
  // Under `prefers-reduced-motion` the lens is off: on hover every tick keeps its
  // rest length, which is still a legible hover cue and the tooltip does the rest.
  const reduced = useReducedMotion();

  // Tick centres in viewport px, measured once per layout instead of per frame.
  // The rail is vertically centred and static between layouts, so only a resize or
  // a change in turn count invalidates it.
  const centers = useRef<number[]>([]);
  const tickNodes = useRef<Array<HTMLButtonElement | null>>([]);
  const measure = useCallback((): void => {
    tickNodes.current.forEach((node, index) => {
      if (!node) return;
      const rect = node.getBoundingClientRect();
      centers.current[index] = rect.top + rect.height / 2;
    });
  }, []);

  useLayoutEffect(() => {
    measure();
  });

  useEffect(() => {
    const node = navRef.current;
    if (!node || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => measure());
    observer.observe(node);
    return () => observer.disconnect();
  }, [measure]);

  const { hit, bar, gap } = densityOf(markers.length);

  return (
    <nav
      ref={navRef}
      aria-label="轮次导航"
      className="pointer-events-none absolute inset-y-0 left-0 z-20 hidden flex-col justify-center @min-[58rem]/thread:flex"
      style={{ width: RAIL_WIDTH }}
    >
      <div
        className={cn(
          // Full width of the fixed gutter so every tick's `w-full` resolves to the
          // same track even as its own bar grows, and the group never reflows.
          "pointer-events-auto relative flex w-full max-h-[86%] flex-col items-start py-1 pl-2.5",
          gap,
        )}
        onPointerMove={(event) => pointerY.set(event.clientY)}
        onPointerEnter={() => hoverRaw.set(reduced ? 0 : 1)}
        onPointerLeave={() => {
          hoverRaw.set(0);
          // Park the pointer on the rail's centre so the ticks retract evenly
          // instead of all easing toward whichever tick was last under the cursor.
          const node = navRef.current;
          if (node) {
            const rect = node.getBoundingClientRect();
            pointerY.set(rect.top + rect.height / 2);
          }
        }}
      >
        {markers.map((marker, index) => (
          <Tick
            key={marker.id}
            marker={marker}
            index={index}
            active={index === active}
            hit={hit}
            bar={bar}
            pointerY={smoothY}
            hover={hover}
            centers={centers}
            tickRef={(node) => {
              tickNodes.current[index] = node;
            }}
          />
        ))}
      </div>
    </nav>
  );
}, (prev, next) => sameMarkers(prev.markers, next.markers) && sameRowIds(prev.rowIds, next.rowIds));
