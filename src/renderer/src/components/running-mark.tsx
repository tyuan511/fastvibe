import type { JSX } from "react";
import { i18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/** Shared circular run mark for conversations, todos, and agent resources. */
export function RunningMark({ className, label }: { className?: string; label?: string }): JSX.Element {
  return (
    <span className="flex size-3.5 shrink-0 items-center justify-center" role="status" aria-label={label ?? (i18n.t("app:running") as string)}>
      <svg
        viewBox="0 0 16 16"
        className={cn("size-3 animate-[spin_0.7s_linear_infinite] text-muted-foreground", className)}
        fill="none"
        aria-hidden="true"
        focusable="false"
      >
        <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.5" opacity="0.15" />
        <path d="M14 8a6 6 0 0 0-6-6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      </svg>
    </span>
  );
}
