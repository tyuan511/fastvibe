import { useMemo, type JSX } from "react";
import { useTranslation } from "react-i18next";
import { HugeiconsIcon } from "@hugeicons/react";
import { ArrowExpand02Icon, WorkflowSquare01Icon } from "@hugeicons/core-free-icons";
import { IconButton } from "@/components/icon-button";
import { useDagStore } from "@/stores/dag";
import { addedDagIds, dagBatch } from "@/lib/dag-batch";
import type { DagNode } from "@shared/dag";
import type { ToolCallBlock } from "@shared/types";
import { DagCanvas, DagSummary } from "./dag-canvas";

/**
 * The tasks one `dag_add_tasks` call created, live, where the call sits in the conversation —
 * instead of a 「创建子任务」 row over a block of JSON.
 *
 * Each call draws the nodes *it* added (a graph that grew over several calls is drawn once per
 * batch, never repeated whole); the 最大化 button opens the conversation's whole graph in a dialog,
 * where a node's details and its sub-agent's execution are. Returns null when the graph is not
 * known here (it was dropped, or this client has no graph data), so the caller falls back to the
 * ordinary tool row.
 */
export function useDagBatch(tool: ToolCallBlock, conversationId: string | null): { conversationId: string; nodes: DagNode[] } | null {
  const ids = useMemo(() => addedDagIds(tool), [tool]);
  const graph = useDagStore((state) => conversationId ? state.graphs[conversationId] : undefined);
  return useMemo(() => dagBatch(graph, conversationId, ids), [graph, conversationId, ids]);
}

export function DagInline({ conversationId, nodes }: { conversationId: string; nodes: DagNode[] }): JSX.Element {
  const { t } = useTranslation("sidepane");
  const openViewer = useDagStore((state) => state.openViewer);

  return (
    <div data-slot="dag-inline" className="flex w-full max-w-2xl flex-col overflow-hidden rounded-xl border border-border bg-card">
      <div className="flex min-w-0 items-center gap-2 px-3 py-2">
        <HugeiconsIcon strokeWidth={2} icon={WorkflowSquare01Icon} className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="shrink-0 text-sm font-medium">{t("dag.title")}</span>
        <div className="min-w-0 flex-1">
          <DagSummary
            nodes={nodes}
            conversationId={conversationId}
            compact
            trailing={
              <IconButton
                size="icon-xs"
                variant="ghost"
                label={t("dag.maximize")}
                className="text-muted-foreground"
                onClick={() => openViewer(conversationId)}
              >
                <HugeiconsIcon strokeWidth={2} icon={ArrowExpand02Icon} />
              </IconButton>
            }
          />
        </div>
      </div>
      <DagCanvas
        nodes={nodes}
        minScale={0.5}
        onSelect={(node) => openViewer(conversationId, node.id, node.runId ? "run" : "detail")}
        className="max-h-[28rem] border-t border-border px-3 py-4"
      />
    </div>
  );
}
