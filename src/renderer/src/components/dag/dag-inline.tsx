import { useMemo, useState, type JSX } from "react";
import { useTranslation } from "react-i18next";
import { HugeiconsIcon } from "@hugeicons/react";
import { ArrowExpand02Icon, ArrowRight01Icon, WorkflowSquare01Icon } from "@hugeicons/core-free-icons";
import { IconButton } from "@/components/icon-button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import { useDagStore } from "@/stores/dag";
import { addedDagIds, dagBatch } from "@/lib/dag-batch";
import type { DagNode } from "@shared/dag";
import type { ToolCallBlock } from "@shared/types";
import { DagTaskList } from "./dag-task-list";
import { DagCanvas, DagGraphActions, DagSummary } from "./dag-canvas";

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

/**
 * The graph occupies the transcript's whole reading column, and a three-task graph is half a
 * screen of dots and cards — more than the run that produced it. So it starts as its own header
 * line, the same one-line-then-click shape as the checklist above the composer: the state, the
 * progress bar and what can be done to the graph all stay on that line (a run in flight is still
 * stoppable without opening anything), and the canvas is one click away.
 *
 * The fold is not remembered: 「默认收起」 is the point, and a graph the reader opened during one
 * run has nothing to say to the next.
 */
export function DagInline({ conversationId, nodes }: { conversationId: string; nodes: DagNode[] }): JSX.Element {
  const { t } = useTranslation("sidepane");
  const openViewer = useDagStore((state) => state.openViewer);
  const [open, setOpen] = useState(false);

  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      data-slot="dag-inline"
      className="flex w-full max-w-2xl flex-col overflow-hidden rounded-xl border border-border bg-card"
    >
      <div className="flex min-w-0 items-center gap-2 px-3 py-2">
        {/* The actions are their own buttons: putting them inside the trigger would drop them (a
            button cannot contain a button) and cancel the graph on a click meant to open it. */}
        <CollapsibleTrigger className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-md text-left focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none">
          <HugeiconsIcon strokeWidth={2} icon={WorkflowSquare01Icon} className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="hidden shrink-0 text-sm font-medium sm:inline">{t("dag.title")}</span>
          <div className="min-w-0 flex-1">
            <DagSummary nodes={nodes} conversationId={conversationId} compact hideActions />
          </div>
        </CollapsibleTrigger>
        <DagGraphActions nodes={nodes} conversationId={conversationId} />
        <IconButton
          size="icon-xs"
          variant="ghost"
          label={t("dag.maximize")}
          className="shrink-0 text-muted-foreground"
          onClick={() => openViewer(conversationId)}
        >
          <HugeiconsIcon strokeWidth={2} icon={ArrowExpand02Icon} />
        </IconButton>
        <CollapsibleTrigger tabIndex={-1} aria-hidden className="shrink-0 cursor-pointer rounded-sm">
          <HugeiconsIcon
            strokeWidth={2}
            icon={ArrowRight01Icon}
            className={cn(
              "size-3.5 shrink-0 text-muted-foreground/60 transition-transform duration-200",
              open && "rotate-90",
            )}
          />
        </CollapsibleTrigger>
      </div>
      <CollapsibleContent>
        <div className="border-t border-border md:hidden">
          <DagTaskList nodes={nodes} limit={4} onSelect={(node) => openViewer(conversationId, node.id, "detail")} />
          {nodes.length > 4 ? (
            <button type="button" className="min-h-11 w-full px-3 text-xs text-muted-foreground" onClick={() => openViewer(conversationId)}>
              {t("dag.viewAll", { count: nodes.length })}
            </button>
          ) : null}
        </div>
        <DagCanvas
          nodes={nodes}
          minScale={0.5}
          onSelect={(node) => openViewer(conversationId, node.id, node.runId ? "run" : "detail")}
          className="hidden max-h-[28rem] border-t border-border px-3 py-4 md:block"
        />
      </CollapsibleContent>
    </Collapsible>
  );
}
