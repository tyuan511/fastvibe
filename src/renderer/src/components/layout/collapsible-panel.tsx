import { useLayoutEffect, useRef, type ReactNode, type JSX } from "react";
import { motion } from "motion/react";
import { cn } from "@/lib/utils";

/**
 * Shared by the workspace sidebar, the right side pane, and the header inset
 * so expand/collapse always lands on the same timing.
 *
 * `bounce: 0` keeps the spring snappy without overshoot — a bouncing splitter
 * reads as a toy, not a desktop shell.
 */
export const PANEL_COLLAPSE_TRANSITION = {
  type: "spring",
  bounce: 0,
  duration: 0.28,
} as const;

/**
 * Width-clip wrapper for a side panel. The inner frame keeps a fixed pixel
 * width (`shrink-0`) so content does not reflow or squash while the outer
 * overflow clips; a right-hand panel is packed against the trailing edge so
 * it closes toward the window edge.
 *
 * Live resize passes `instant` so the splitter follows the pointer. Collapse
 * and expand always spring, even if a drag just crossed the minimum.
 *
 * `overlay` switches it from pushing to covering, and covers the whole viewport. A phone
 * has no width to give: the sidebar's minimum alone is most of a 375pt screen, so there
 * it slides over the conversation as a full-screen drawer instead of squeezing it into a
 * strip. Same component, because the panel is the same panel — only what it does to its
 * neighbour changes.
 */
export function CollapsiblePanel({
  collapsed,
  width,
  side,
  instant,
  maximized,
  overlay,
  children,
  className,
}: {
  collapsed: boolean;
  width: number;
  side: "left" | "right";
  instant?: boolean;
  maximized?: boolean;
  /** Cover the layout instead of taking room from it. Used on narrow viewports. */
  overlay?: boolean;
  children: ReactNode;
  className?: string;
}): JSX.Element {
  const fill = Boolean(maximized && !collapsed);
  const frameRef = useRef<HTMLDivElement>(null);
  const clipWidthRef = useRef(width);

  useLayoutEffect(() => {
    if (collapsed) return;
    clipWidthRef.current = fill && frameRef.current ? frameRef.current.offsetWidth : width;
  }, [collapsed, fill, width]);

  const innerWidth = fill ? "100%" : collapsed ? clipWidthRef.current : width;

  /**
   * Both modes drive both properties, always.
   *
   * Motion only writes the keys an `animate` object names, and leaves every other inline
   * value it wrote earlier exactly where it was. So a branch that animated `x` and a
   * branch that animated `width` left each other's last frame behind on the way past:
   * switching from drawer to column kept `translateX(-100%)` and parked the sidebar
   * off-screen on a desktop-width window, which is a stuck layout rather than a
   * mis-timed one, and it only appears when the viewport crosses the breakpoint.
   */
  const animate = overlay
    ? { x: collapsed ? (side === "right" ? "100%" : "-100%") : 0, width: "100vw" }
    : { x: 0, width: collapsed ? 0 : fill ? "auto" : width };

  return (
    <motion.div
      initial={false}
      animate={animate}
      transition={(instant && !collapsed) || fill ? { duration: 0 } : PANEL_COLLAPSE_TRANSITION}
      className={cn(
        "flex h-full min-h-0 min-w-0 overflow-hidden",
        overlay
          ? cn(
              "absolute inset-y-0 z-50 border-border bg-background shadow-xl",
              side === "right" ? "right-0 border-l" : "left-0 border-r",
            )
          : cn(fill ? "flex-1" : "shrink-0", side === "right" ? "justify-end" : "justify-start"),
        className,
      )}
      /*
       * Nothing caps the drawer's width.
       *
       * It used to be capped at the remembered column width, on the theory that a
       * desktop's 288px was wider than the phone covering it. On a phone that number is
       * not a ceiling, it is *the* width — and `clampSidebarWidth` scaled its maximum to
       * 40% of the viewport, so a 375pt screen read the remembered width back as 150 and
       * the drawer opened as a sliver with the conversation showing beside it. A phone
       * has nothing to show beside it: the drawer is the screen.
       */
      aria-hidden={collapsed}
      inert={collapsed || undefined}
    >
      <div
        ref={frameRef}
        className={cn("flex h-full min-h-0 flex-col", overlay ? "w-full" : "shrink-0")}
        style={overlay ? undefined : { width: innerWidth }}
      >
        {children}
      </div>
    </motion.div>
  );
}
