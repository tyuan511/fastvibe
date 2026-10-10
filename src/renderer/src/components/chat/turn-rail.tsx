import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  type JSX,
  type MutableRefObject,
} from "react";
import { useTranslation } from "react-i18next";
import { motion, useMotionValue, useReducedMotion, useSpring, useTransform, type MotionValue } from "motion/react";
import { useMessageScroller } from "@/components/ui/message-scroller";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { activeTurnIndex } from "@/lib/turn-rail";
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
  /** Position of the prompt's row in the flat transcript. */
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

/** How far below the viewport's top edge a turn counts as the one being read (px).
 *  The scroller's own "at the top edge" margin, so the highlight flips when a
 *  prompt reaches the reading position rather than the instant it peeks in. */
const READING_LINE = 64;

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
  const { t } = useTranslation("chat");
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
            aria-label={t("turns.turn", { n: index + 1, prompt: marker.prompt })}
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
  scrollOffset,
  turnStarts,
}: {
  markers: TurnMarker[];
  /** The viewport's scroll position, in the same coordinate as `turnStarts`. */
  scrollOffset: number;
  /** Each turn's position in the transcript, in order. A turn the virtualizer has
   *  not measured yet is `undefined` and cannot win the highlight. */
  turnStarts: ReadonlyArray<number | undefined>;
}): JSX.Element {
  const { t } = useTranslation("chat");
  const navRef = useRef<HTMLElement | null>(null);

  // The reading line sits one inset below the viewport's top edge — the same inset
  // the scroller treats as "at the top" — so a prompt lights up as it arrives
  // there, not while it is still sliding in under the sticky row above it.
  const active = activeTurnIndex(turnStarts, scrollOffset + READING_LINE);

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
      aria-label={t("turns.nav")}
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
}, (prev, next) =>
  sameMarkers(prev.markers, next.markers) &&
  prev.scrollOffset === next.scrollOffset &&
  sameStarts(prev.turnStarts, next.turnStarts));

/** Positions change when a turn is measured or grows, never on a streamed token. */
function sameStarts(a: ReadonlyArray<number | undefined>, b: ReadonlyArray<number | undefined>): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) return false;
  }
  return true;
}
