import type { JSX } from "react";
import { useTranslation } from "react-i18next";
import type { DagSettledInfo } from "@shared/types";

/**
 * The graph-settled mark. The custom message that wakes the main agent carries the
 * task list and a dag_result instruction; none of that belongs in the thread. This
 * is the same quiet rule as a model switch: one fact, between the turns.
 */
export function DagSettledNotice({ dag }: { dag?: DagSettledInfo }): JSX.Element {
  const { t } = useTranslation("chat");
  const detail = [
    dag?.completed ? t("dag.completed", { count: dag.completed }) : "",
    dag?.failed ? t("dag.failed", { count: dag.failed }) : "",
    dag?.skipped ? t("dag.skipped", { count: dag.skipped }) : "",
    dag?.cancelled ? t("dag.cancelled", { count: dag.cancelled }) : "",
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <div className="flex w-full items-center gap-3 py-1 text-xs text-muted-foreground/60">
      <span aria-hidden className="h-px min-w-4 flex-1 bg-border" />
      <span className="flex min-w-0 items-center gap-1.5">
        <span className="shrink-0">{t("dag.settled")}</span>
        {detail ? (
          <>
            <span className="shrink-0 text-muted-foreground/40">·</span>
            <span className="min-w-0 truncate font-medium text-muted-foreground/80">{detail}</span>
          </>
        ) : null}
      </span>
      <span aria-hidden className="h-px min-w-4 flex-1 bg-border" />
    </div>
  );
}
