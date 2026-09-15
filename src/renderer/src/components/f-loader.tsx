import type { JSX } from "react";
import { F_MARK_LINE, F_MARK_VIEWBOX } from "@/lib/f-mark";
import { cn } from "@/lib/utils";

/**
 * The FastVibe F traced as a single SVG stroke — the app's global loading mark.
 *
 * It draws the glyph's outer contour (see `f-mark.ts`) with a dash animation, so
 * the line grows, holds, then erases. Colour rides `currentColor`, so it follows
 * whatever theme the caller is in. `index.html` paints the same mark before the
 * bundle runs; `dismissBootLoader()` hands that node off to this one.
 */
export function FLoader({
  className,
  label = "加载中",
}: {
  className?: string;
  /** Accessible name; the mark is decorative chrome when a label is already shown. */
  label?: string;
}): JSX.Element {
  return (
    <svg
      viewBox={F_MARK_VIEWBOX}
      role="status"
      aria-label={label}
      fill="none"
      className={cn("block size-11 text-muted-foreground", className)}
    >
      <path className="fv-loader-path" pathLength={1} d={F_MARK_LINE} />
    </svg>
  );
}
