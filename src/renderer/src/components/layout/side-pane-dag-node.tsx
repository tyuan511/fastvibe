import { useMemo, type JSX } from "react";
import { useTranslation } from "react-i18next";
import { DagNodeDetail } from "@/components/dag/dag-node-detail";
import { SidePaneSubagent } from "@/components/layout/side-pane-subagent";
import { useDagStore } from "@/stores/dag";
import { useSidePaneStore, type SidePaneTab } from "@/stores/side-pane";
import { dagRunStatus } from "@shared/dag";
import { subagentKey } from "@shared/subagent-state";

/**
 * One DAG node, in the conversation's side pane.
 *
 * A node that has run is the same read-only transcript a delegated run uses
 * (`SidePaneSubagent`); the tab follows the node's current `runId`, so a retry
 * replaces the previous execution instead of appending to it. A node that has
 * not started yet has no transcript, so the pane shows its details.
 */
export function SidePaneDagNode({ tab }: { tab: SidePaneTab }): JSX.Element {
  const { t } = useTranslation("sidepane");
  const conversationId = tab.subagentConversationId;
  const graph = useDagStore((state) => (conversationId ? state.graphs[conversationId] : undefined));
  const node = graph?.nodes.find((item) => item.id === tab.dagNodeId);
  const openDagNode = useSidePaneStore((state) => state.openDagNode);

  const runTab = useMemo<SidePaneTab | null>(() => {
    if (!node?.runId || !conversationId) return null;
    return {
      id: `dag-run:${subagentKey(node.runId, conversationId)}`,
      type: "subagent",
      openedAt: node.startedAt ?? node.createdAt,
      title: node.profile.name,
      conversationId,
      subagentId: node.runId,
      subagentConversationId: conversationId,
      subagentStatus: dagRunStatus(node.status),
      subagentBrief: node.instruction,
    };
  }, [conversationId, node]);

  if (!node || !conversationId || !graph) {
    return (
      <div className="flex h-full items-center justify-center px-6 text-center text-sm text-muted-foreground">
        {t("dag.gone")}
      </div>
    );
  }
  if (runTab) return <SidePaneSubagent key={runTab.id} tab={runTab} />;
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <DagNodeDetail
        node={node}
        nodes={graph.nodes}
        conversationId={conversationId}
        onSelectNode={(id) => {
          const next = graph.nodes.find((item) => item.id === id);
          if (next) openDagNode(conversationId, next);
        }}
        onOpenRun={() => undefined}
      />
    </div>
  );
}
