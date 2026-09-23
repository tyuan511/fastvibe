import { useCallback, useEffect, useRef, useState } from "react";
import { usePanelRef, type PanelProps, type PanelSize } from "react-resizable-panels";

/**
 * Matches `PANEL_COLLAPSE_TRANSITION.duration` in `layout/collapsible-panel.tsx`,
 * which still owns the narrow-viewport drawer's spring.
 */
const PANEL_ANIMATE_MS = 280;

/**
 * How long the shell waits after the last resize event before writing the settled
 * width out. The library reports every frame of a drag; the preference is written
 * once, when the pointer stops.
 */
const PERSIST_DEBOUNCE_MS = 150;

export type SidePanelOptions = {
  /** Key the library stores this panel's layout under, and its DOM id. */
  id: string;
  /** Resting width in px, read from the persisted preference. */
  width: number;
  /** Whether the panel is collapsed right now. */
  collapsed: boolean;
  /** Pixels below which a drag collapses the panel instead of stopping. */
  minSize: number;
  /**
   * Upper bound, as a share of the shell (a number, or a `"40%"` string) or in px.
   * A share keeps its meaning when the window is resized, which a pixel ceiling
   * read off `window.innerWidth` once would not.
   */
  maxSize: number | string;
  /** Write the settled width, in px, to the persisted preference. */
  persist: (width: number) => void;
  /**
   * Report a collapse or expand the library performed on its own — a drag that
   * crossed the minimum — so the store follows the panel instead of drifting from
   * it. Called only when the state actually changes.
   */
  reportCollapsed: (collapsed: boolean) => void;
  /**
   * Let the panel exceed `maxSize`. The side pane needs this while it is maximised:
   * with the conversation column gone it owns the rest of the window, which is more
   * than the share it may take beside one.
   */
  liftCeiling?: boolean;
  /**
   * Resize an open panel whenever `width` changes from outside. The side pane
   * remembers a width per conversation, so a chat switch hands it a new one; the
   * sidebar's width only ever comes back from its own drags and leaves this off.
   */
  followWidth?: boolean;
};

/** The `Panel` props this hook drives; everything else is the caller's. */
export type SidePanelProps = Pick<
  PanelProps,
  | "aria-hidden"
  | "collapsedSize"
  | "collapsible"
  | "defaultSize"
  | "elementRef"
  | "groupResizeBehavior"
  | "id"
  | "inert"
  | "maxSize"
  | "minSize"
  | "onResize"
  | "panelRef"
>;

/** Is `size` past the ceiling? Percentages are compared as percentages. */
function isOver(size: PanelSize, maxSize: number | string): boolean {
  return typeof maxSize === "number" ? size.inPixels > maxSize : size.asPercentage > Number.parseFloat(maxSize);
}

/**
 * Wires one of the shell's side panels (the workspace sidebar, the right side pane)
 * to `react-resizable-panels`, while the app's own state stays the source of truth:
 * the resting width lives in a persisted preference and the collapsed flag in a
 * store, and the library is told to follow them rather than the other way round.
 *
 * Three behaviours the library knows nothing about are carried over from the
 * hand-rolled splitter it replaces:
 *
 * - Dragging past the minimum collapses the panel, and the stored width is left
 *   alone so the header toggle reopens it where it was.
 * - Collapse and expand spring; a live drag does not. CSS driven off a `data-animate`
 *   attribute this hook writes for the duration of the transition (see the "Side
 *   panel splitters" block in `index.css`).
 * - The size ceiling lifts itself while a panel is over it, so a maximised pane is
 *   never squeezed back down by the limit it has just outgrown.
 */
export function useSidePanel({
  id,
  width,
  collapsed,
  minSize,
  maxSize,
  persist,
  reportCollapsed,
  liftCeiling = false,
  followWidth = false,
}: SidePanelOptions): SidePanelProps {
  const panelRef = usePanelRef();
  const elementRef = useRef<HTMLDivElement | null>(null);

  // Read once: the library takes `defaultSize` when it first measures the group,
  // and feeding it the live value would make every persisted drag a new "default".
  const [defaultSize] = useState(() => (collapsed ? 0 : width));

  const widthRef = useRef(width);
  widthRef.current = width;

  const persistRef = useRef(persist);
  persistRef.current = persist;

  const reportRef = useRef(reportCollapsed);
  reportRef.current = reportCollapsed;
  const reportedCollapsed = useRef(collapsed);

  const maxSizeRef = useRef(maxSize);
  maxSizeRef.current = maxSize;
  const [overCeiling, setOverCeiling] = useState(false);
  const [ceilingLifted, setCeilingLifted] = useState(false);
  useEffect(() => {
    // Raised on request, and held until the panel is measured back under its ceiling:
    // maximising the side pane leaves it wider than the share it may take beside a
    // conversation column for a frame or two after the column returns, and a ceiling
    // that snapped shut first would make the library hand the difference to whichever
    // panel it found next. It is never raised by a panel merely growing past its
    // ceiling, or a keyboard resize would run away with it.
    if (liftCeiling) setCeilingLifted(true);
    else if (!overCeiling) setCeilingLifted(false);
  }, [liftCeiling, overCeiling]);

  const animationTimer = useRef<number | null>(null);
  const persistTimer = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (animationTimer.current !== null) window.clearTimeout(animationTimer.current);
      if (persistTimer.current !== null) window.clearTimeout(persistTimer.current);
    },
    [],
  );

  // Store → panel, and only when the collapsed flag actually flips. A drag that
  // ends below the minimum collapses the panel inside the library and reports 0
  // back through `onResize`; replaying that same collapse would be a no-op, and
  // re-driving the panel on every width change would fight the library's own
  // bookkeeping.
  const previousCollapsed = useRef(collapsed);
  useEffect(() => {
    if (previousCollapsed.current === collapsed) return;
    previousCollapsed.current = collapsed;
    // A frame's delay, because the panel is not always there yet. Crossing the
    // narrow-viewport breakpoint swaps the sidebar between a panel and a full-screen
    // drawer, and the panel that comes back mounts in this commit — before the
    // library has registered it, so there is nothing to resize.
    const frame = requestAnimationFrame(() => {
      if (collapsed) panelRef.current?.collapse();
      // Not `expand()`: that falls back to `minSize` for a panel that has never been
      // expanded, and the width to reopen at is the one the store already remembers.
      else panelRef.current?.resize(widthRef.current);

      const element = elementRef.current;
      if (!element) return;
      // Written before the library commits the new size, so the transition has
      // something to run on; cleared when it has had time to finish.
      element.dataset.animate = "";
      element.style.setProperty("--panel-width", `${widthRef.current}px`);
      if (animationTimer.current !== null) window.clearTimeout(animationTimer.current);
      animationTimer.current = window.setTimeout(() => {
        animationTimer.current = null;
        delete element.dataset.animate;
        element.style.removeProperty("--panel-width");
      }, PANEL_ANIMATE_MS);
    });
    return () => cancelAnimationFrame(frame);
  }, [collapsed]);

  // Width → panel, for a width that changed while the panel stayed open. A width
  // this panel just persisted matches its own size and is left alone; a collapsed
  // panel is skipped, since the expand above already reopens it at `widthRef`.
  useEffect(() => {
    // Maximised, the pane's size belongs to the shell's maximise dance, not to a width.
    if (!followWidth || collapsed || liftCeiling) return;
    const frame = requestAnimationFrame(() => {
      const panel = panelRef.current;
      if (!panel || panel.isCollapsed()) return;
      if (Math.abs(panel.getSize().inPixels - width) < 1) return;
      panel.resize(width);
    });
    return () => cancelAnimationFrame(frame);
  }, [followWidth, width]);

  const onResize = useCallback((size: PanelSize) => {
    // The ceiling follows the panel rather than the other way round: it is lifted
    // exactly while the panel is over it, so a maximised pane (or one whose stored
    // width outgrew a smaller window) is never squeezed back down by its own limit.
    setOverCeiling((previous) => {
      const next = isOver(size, maxSizeRef.current);
      return next === previous ? previous : next;
    });

    // Panel → store. A drag that runs past the minimum collapses the panel inside the
    // library, and nothing else would tell the store: the header's expand control
    // would then sit there offering to open a pane that is already shut.
    const nextCollapsed = size.inPixels <= 0;
    if (reportedCollapsed.current !== nextCollapsed) {
      reportedCollapsed.current = nextCollapsed;
      reportRef.current(nextCollapsed);
    }

    // A collapsed panel measures 0. That is not a width to remember: what the panel
    // should reopen at is the last one it really had, which the store still holds.
    if (nextCollapsed) return;
    const settle = (): void => {
      // The library collapses a panel the moment a drag crosses its minimum, and it
      // reports the floor on the way there. Waiting until the dust settles and
      // asking the panel itself keeps that in-between width from being stored as the
      // width to reopen at.
      if (panelRef.current?.isCollapsed()) return;
      persistRef.current(size.inPixels);
    };
    if (persistTimer.current !== null) window.clearTimeout(persistTimer.current);
    persistTimer.current = window.setTimeout(() => {
      persistTimer.current = null;
      settle();
    }, PERSIST_DEBOUNCE_MS);
  }, []);

  return {
    id,
    collapsible: true,
    collapsedSize: 0,
    defaultSize,
    elementRef,
    // A side column keeps its pixels when the window is resized; the conversation
    // column between them absorbs the difference, exactly as the fixed-width frame
    // this replaced did.
    groupResizeBehavior: "preserve-pixel-size",
    // A collapsed panel is a zero-width box that still holds live content: keep it
    // out of the tab order and out of the accessibility tree, the way the width-clip
    // wrapper it replaces did.
    inert: collapsed || undefined,
    "aria-hidden": collapsed || undefined,
    maxSize: ceilingLifted ? undefined : maxSize,
    minSize,
    onResize,
    panelRef,
  };
}
