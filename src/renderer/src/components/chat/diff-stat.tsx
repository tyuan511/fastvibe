import type { JSX } from "react";

/** Inline `+14 −12` on a file-change row. No chip — it sits in the same line as the file name. */
export function DiffStatBadge({ added, removed }: { added: number; removed: number }): JSX.Element | null {
  if (added <= 0 && removed <= 0) return null;
  return (
    <span className="shrink-0 font-mono text-sm">
      <span className="text-success">+{added}</span> <span className="text-destructive">−{removed}</span>
    </span>
  );
}
