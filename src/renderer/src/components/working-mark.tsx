import type { JSX } from "react";
import { i18n } from "@/lib/i18n";

const DOT_CENTERS = [16, 40, 64] as const;
const DOTS = DOT_CENTERS.flatMap((cy, row) => DOT_CENTERS.map((cx, column) => (
  <circle key={`${row}:${column}`} cx={cx} cy={cy} r={8} style={{ animationDelay: `${-(row + column) * 0.4}s` }} />
)));

/** The nine-dot grid belongs only to the reply's Working row. */
export function WorkingMark({ label }: { label?: string }): JSX.Element {
  return (
    <span
      className="flex size-3.5 shrink-0 items-center justify-center text-muted-foreground"
      role="status"
      aria-label={label ?? (i18n.t("app:running") as string)}
    >
      <svg viewBox="0 0 80 80" className="running-grid size-full" fill="currentColor" aria-hidden="true" focusable="false">
        {DOTS}
      </svg>
    </span>
  );
}
