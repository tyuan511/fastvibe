import type { JSX } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { AlertCircleIcon, Cancel01Icon, CheckmarkCircle02Icon, MinusSignCircleIcon } from "@hugeicons/core-free-icons";
import { RunningMark } from "@/components/running-mark";
import type { DagNodeStatus } from "@shared/dag";

/** One glyph per node state, shared by the graph and the sidebar's sub-task rows. */
export function DagStatusIcon({ status, label }: { status: DagNodeStatus; label: string }): JSX.Element {
  switch (status) {
    case "running":
      return <RunningMark className="text-warning" label={label} />;
    case "completed":
      return <HugeiconsIcon strokeWidth={2} icon={CheckmarkCircle02Icon} className="size-3.5 shrink-0 text-success" aria-label={label} />;
    case "blocked":
      return <HugeiconsIcon strokeWidth={2} icon={AlertCircleIcon} className="size-3.5 shrink-0 text-warning" aria-label={label} />;
    case "failed":
      return <HugeiconsIcon strokeWidth={2} icon={AlertCircleIcon} className="size-3.5 shrink-0 text-destructive" aria-label={label} />;
    case "skipped":
      return <HugeiconsIcon strokeWidth={2} icon={MinusSignCircleIcon} className="size-3.5 shrink-0 text-muted-foreground" aria-label={label} />;
    case "cancelled":
      return <HugeiconsIcon strokeWidth={2} icon={Cancel01Icon} className="size-3.5 shrink-0 text-muted-foreground" aria-label={label} />;
    default:
      return (
        <svg viewBox="0 0 16 16" fill="none" className="size-3.5 shrink-0 text-muted-foreground" role="img" aria-label={label}>
          <circle cx="8" cy="8" r="6.25" stroke="currentColor" strokeWidth="1.5" strokeDasharray="2.2 2.2" />
        </svg>
      );
  }
}
