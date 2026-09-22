import type { ReactNode, JSX } from "react";
import { motion } from "motion/react";
import { cn } from "@/lib/utils";

/**
 * Expand/collapse timing for the shell's side chrome. The conversation header's
 * inset animates on this and the narrow-viewport drawer springs on it, so a
 * sidebar opening and the bar beside it land together.
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
 * The narrow-viewport sidebar: a full-screen drawer that slides over the
 * conversation instead of pushing it aside.
 *
 * A phone has no width to give — the sidebar's minimum alone is most of a 375pt
 * screen — so there the panel covers the layout rather than taking room from it.
 * Nothing caps its width: it used to be capped at the remembered column width, and
 * `clampSidebarWidth` scaled that to 40% of the viewport, so a 375pt screen read the
 * remembered width back as 150 and opened as a sliver with the conversation showing
 * beside it. A phone has nothing to show beside it: the drawer is the screen.
 *
 * On a desktop-width layout the sidebar is a column of the resizable group instead
 * (see `components/layout/sidebar.tsx` and `lib/use-resizable-panel.ts`), which is
 * where its width and its splitter live.
 *
 * Both properties are driven on every render, always. Motion only writes the keys an
 * `animate` object names and leaves every other inline value it wrote earlier exactly
 * where it was, so a branch that animated `x` and one that animated `width` left each
 * other's last frame behind on the way past: switching from drawer to column kept
 * `translateX(-100%)` and parked the sidebar off-screen on a desktop-width window,
 * which is a stuck layout rather than a mis-timed one, and it only appears when the
 * viewport crosses the breakpoint.
 */
export function CollapsiblePanel({
  collapsed,
  side,
  children,
  className,
}: {
  collapsed: boolean;
  /** Which edge the drawer is packed against, and so which way it slides in from. */
  side: "left" | "right";
  children: ReactNode;
  className?: string;
}): JSX.Element {
  return (
    <motion.div
      initial={false}
      animate={{ x: collapsed ? (side === "right" ? "100%" : "-100%") : 0, width: "100vw" }}
      transition={PANEL_COLLAPSE_TRANSITION}
      className={cn(
        "absolute inset-y-0 z-50 flex h-full min-h-0 min-w-0 overflow-hidden border-border bg-background shadow-xl",
        side === "right" ? "right-0 border-l" : "left-0 border-r",
        className,
      )}
      aria-hidden={collapsed}
      inert={collapsed || undefined}
    >
      <div className="flex h-full min-h-0 w-full flex-col">{children}</div>
    </motion.div>
  );
}
