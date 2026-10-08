import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { dagProgress, dagTaskRows } from "@shared/dag-view";
import type { DagNode } from "@shared/dag";
import { DagStatusIcon } from "@/components/dag-status-icon";
import { useDagStore } from "@/stores/dag";

/** Narrow screens read an ownership tree; dependencies are links in the node detail. */
export function DagTaskList({ nodes, onSelect, limit }: { nodes: DagNode[]; onSelect: (node: DagNode) => void; limit?: number }) {
  const { t } = useTranslation("sidepane");
  const rows = useMemo(() => dagTaskRows(nodes), [nodes]);
  return <div className="divide-y divide-border/60">
    {rows.slice(0, limit).map(({ node, depth, previousAttempt }) => <button key={node.id} type="button" onClick={() => onSelect(node)}
      className="flex min-h-14 w-full items-center gap-2 px-3 py-3 text-left hover:bg-muted/50 active:bg-muted" style={{ paddingLeft: 12 + Math.min(depth, 3) * 14 }}>
      <DagStatusIcon status={node.status} label={t(`dag.status.${node.status}`)} />
      <span className="min-w-0 flex-1"><span className="flex items-center gap-2 text-xs text-muted-foreground"><span className="font-mono">{node.id}</span><span>{t(`dag.status.${node.status}`)}</span>{node.coordinator ? <span className="rounded bg-muted px-1">{t("dag.coordinator")}</span> : null}</span>
        <span className="mt-0.5 block text-sm font-medium break-words">{node.title}</span>
        {previousAttempt ? <span className="text-xs text-muted-foreground">{t("dag.previousAttempt")}</span> : null}
      </span>
    </button>)}
  </div>;
}

export function DagMobileSummary({ conversationId }: { conversationId: string | null }) {
  const { t } = useTranslation("sidepane");
  const graph = useDagStore((state) => conversationId ? state.graphs[conversationId] : undefined);
  if (!conversationId || !graph?.nodes.length) return null;
  const progress = dagProgress(graph.nodes);
  return <button type="button" onClick={() => useDagStore.getState().openViewer(conversationId)} aria-label={t("dag.openTasks")}
    className="flex min-h-11 shrink-0 items-center gap-2 border-b border-border/60 bg-card px-4 py-2 text-left text-xs">
    <span className="font-medium">{t("dag.title")}</span>
    <span className="flex-1 text-muted-foreground">{t("dag.progress", { done: progress.completed, total: progress.total })}</span>
    {progress.attention ? <span className="text-warning">{t("dag.attention", { count: progress.attention })}</span> : null}
  </button>;
}
