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
 */
export function CollapsiblePanel({
  collapsed,
  width,
  side,
  instant,
  maximized,
  children,
  className,
}: {
  collapsed: boolean;
  width: number;
  side: "left" | "right";
  instant?: boolean;
  maximized?: boolean;
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

  return (
    <motion.div
      initial={false}
      animate={collapsed ? { width: 0 } : fill ? { width: "auto" } : { width }}
      transition={instant && !collapsed || fill ? { duration: 0 } : PANEL_COLLAPSE_TRANSITION}
      className={cn(
        "flex h-full min-h-0 min-w-0 overflow-hidden",
        fill ? "flex-1" : "shrink-0",
        side === "right" ? "justify-end" : "justify-start",
        className,
      )}
      aria-hidden={collapsed}
      inert={collapsed || undefined}
    >
      <div
        ref={frameRef}
        className="flex h-full min-h-0 shrink-0 flex-col"
        style={{ width: innerWidth }}
      >
        {children}
      </div>
    </motion.div>
  );
}
