import { useMemo, type JSX } from "react";
import { useTranslation } from "react-i18next";
import { HugeiconsIcon } from "@hugeicons/react";
import { Task01Icon, WorkflowSquare01Icon } from "@hugeicons/core-free-icons";
import { DagStatusIcon } from "@/components/dag-status-icon";
import { SidePaneSubagent } from "@/components/layout/side-pane-subagent";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useDagStore } from "@/stores/dag";
import type { SidePaneTab } from "@/stores/side-pane";
import { dagRunStatus, type DagNode } from "@shared/dag";
import { subagentKey } from "@shared/subagent-state";
import { DagCanvas, DagSummary } from "./dag-canvas";
import { DagTaskList } from "./dag-task-list";
import { Button } from "@/components/ui/button";
import { DagNodeDetail } from "./dag-node-detail";

/**
 * A conversation's whole graph, maximised: the graph on the left, and on the right the node picked
 * in it — its details, or its sub-agent's execution, as the same read-only transcript a delegated
 * run is drawn with (`SidePaneSubagent`, stop button included).
 *
 * One dialog for the window, opened from the inline graph through `useDagStore.openViewer`.
 * The sidebar's sub-task rows open the same node in the side pane instead.
 */
export function DagDialog(): JSX.Element {
  const { t } = useTranslation("sidepane");
  const viewer = useDagStore((state) => state.viewer);
  const graph = useDagStore((state) => (state.viewer ? state.graphs[state.viewer.conversationId] : undefined));
  const { selectNode, setView, closeViewer } = useDagStore.getState();
  const nodes = graph?.nodes ?? [];
  const node = viewer?.nodeId ? nodes.find((item) => item.id === viewer.nodeId) : undefined;
  const open = Boolean(viewer && graph);

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? undefined : closeViewer())}>
      <DialogContent className="flex h-[min(54rem,92dvh)] w-[min(80rem,95vw)] max-w-none flex-col gap-0 overflow-hidden p-0 sm:max-w-none">
        <DialogHeader className="shrink-0 border-b border-border px-4 py-3">
          <DialogTitle className="flex items-center gap-2 pr-8">
            <HugeiconsIcon strokeWidth={2} icon={WorkflowSquare01Icon} className="size-4 text-muted-foreground" />
            {node ? <Button variant="ghost" size="xs" className="md:hidden" onClick={() => useDagStore.getState().openViewer(viewer!.conversationId)}>{t("dag.backToList")}</Button> : null}
            {t("dag.title")}
          </DialogTitle>
        </DialogHeader>
        {viewer && graph ? (
          <div className="flex min-h-0 flex-1 flex-col md:flex-row">
            <div className={`${node ? "hidden md:flex" : "flex"} min-h-0 min-w-0 flex-1 flex-col`}>
              <DagSummary nodes={nodes} conversationId={viewer.conversationId} />
              <div className="min-h-0 flex-1 overflow-y-auto md:hidden"><DagTaskList nodes={nodes} onSelect={(picked) => selectNode(picked.id, "detail")} /></div>
              <DagCanvas
                nodes={nodes}
                selectedId={viewer.nodeId}
                onSelect={(picked) => selectNode(picked.id, picked.runId ? viewer.view : "detail")}
                minScale={0.6}
                className="hidden min-h-0 flex-1 border-t border-border px-6 py-6 md:block"
              />
            </div>
            <aside className={`${node ? "flex flex-1 md:flex-none" : "hidden md:flex"} min-h-0 flex-col border-t border-border md:w-[28rem] md:shrink-0 md:border-t-0 md:border-l`}>
              {node ? (
                <NodePane node={node} nodes={nodes} conversationId={viewer.conversationId} view={viewer.view} onView={setView} onSelect={(id) => selectNode(id, "detail")} />
              ) : (
                <div className="m-auto flex max-w-64 flex-col items-center gap-2 px-6 py-10 text-center">
                  <span className="flex size-9 items-center justify-center rounded-full bg-muted text-muted-foreground">
                    <HugeiconsIcon strokeWidth={2} icon={Task01Icon} className="size-4.5" />
                  </span>
                  <p className="text-sm text-muted-foreground">{t("dag.pickNode")}</p>
                </div>
              )}
            </aside>
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function NodePane({
  node,
  nodes,
  conversationId,
  view,
  onView,
  onSelect,
}: {
  node: DagNode;
  nodes: DagNode[];
  conversationId: string;
  view: "detail" | "run";
  onView: (view: "detail" | "run") => void;
  onSelect: (id: string) => void;
}): JSX.Element {
  const { t } = useTranslation("sidepane");
  const showRun = view === "run" && Boolean(node.runId);
  // The execution view is the delegated-run pane, handed a tab-shaped description of this run.
  const runTab = useMemo<SidePaneTab | null>(
    () =>
      node.runId
        ? {
            id: `dag-run:${subagentKey(node.runId, conversationId)}`,
            type: "subagent",
            openedAt: node.startedAt ?? node.createdAt,
            title: node.profile.name,
            conversationId,
            subagentId: node.runId,
            subagentConversationId: conversationId,
            subagentStatus: dagRunStatus(node.status),
            subagentBrief: node.instruction,
          }
        : null,
    [conversationId, node.createdAt, node.instruction, node.profile.name, node.runId, node.startedAt, node.status],
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-4 py-2">
        <DagStatusIcon status={node.status} label={t(`dag.status.${node.status}`)} />
        <span className="font-mono text-xs text-muted-foreground">{node.id}</span>
        <span className="min-w-0 flex-1 truncate text-sm font-medium" title={node.title}>
          {node.title}
        </span>
        <Tabs value={showRun ? "run" : "detail"} onValueChange={(value) => onView(value as "detail" | "run")}>
          <TabsList className="h-7">
            <TabsTrigger value="detail" className="px-2 text-xs">
              {t("dag.tabDetail")}
            </TabsTrigger>
            <TabsTrigger value="run" className="px-2 text-xs" disabled={!node.runId}>
              {t("dag.tabRun")}
            </TabsTrigger>
          </TabsList>
        </Tabs>
      </div>
      {showRun && runTab ? (
        <div className="flex min-h-0 flex-1 flex-col">
          <SidePaneSubagent key={runTab.id} tab={runTab} />
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <DagNodeDetail node={node} nodes={nodes} conversationId={conversationId} onSelectNode={onSelect} onOpenRun={() => onView("run")} />
        </div>
      )}
    </div>
  );
}
