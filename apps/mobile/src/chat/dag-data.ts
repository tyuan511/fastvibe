import { canonicalDagId, DAG_NODE_STATUSES, type DagGraph } from "../../../../src/shared/dag.ts";

export type DagSource = {
  call(method: string, payload?: unknown): Promise<unknown>;
  onEvent(listener: (event: Record<string, unknown>) => void): () => void;
};

function graphOf(value: unknown, conversationId: string): DagGraph | null {
  if (!value || typeof value !== "object") return null;
  const graph = value as DagGraph;
  if (graph.conversationId !== conversationId || !Array.isArray(graph.nodes)) return null;
  if (graph.nodes.some((node) => !node || typeof node.id !== "string" || typeof node.title !== "string" || !node.profile || !Array.isArray(node.dependsOn) || !DAG_NODE_STATUSES.includes(node.status))) return null;
  return graph;
}

/** Scope to one chat and client. Events (including deletion) win over a concurrent list response. */
export function watchMobileDag(source: DagSource, conversationId: string, update: (graph: DagGraph | null) => void, failure: (error: unknown) => void) {
  let disposed = false;
  let version = 0;
  let request = 0;
  let current: DagGraph | null = null;
  const accept = (graph: DagGraph | null): void => {
    if (graph && current && (graph.revision ?? 0) < (current.revision ?? 0)) return;
    current = graph; update(graph);
  };
  const off = source.onEvent((event) => {
    if (disposed || event.type !== "dag_changed" || event.conversationId !== conversationId) return;
    const graph = graphOf(event.graph, conversationId);
    if (event.graph !== null && !graph) return;
    version++;
    accept(graph);
  });
  const refresh = async (): Promise<void> => {
    const pendingVersion = version;
    const pendingRequest = ++request;
    try {
      const result = await source.call("dag:list");
      if (disposed || pendingRequest !== request) return;
      const value = Array.isArray(result) ? result.find((item) => item?.conversationId === conversationId) : null;
      const graph = graphOf(value, conversationId);
      if (pendingVersion !== version && (!current || !graph || (graph.revision ?? 0) <= (current.revision ?? 0))) return;
      accept(graph);
    } catch (error) { if (!disposed && pendingRequest === request && pendingVersion === version) failure(error); }
  };
  void refresh();
  return { refresh, dispose: () => { disposed = true; off(); } };
}

export function dagToolNodeId(args: unknown): string | undefined {
  if (!args || typeof args !== "object") return undefined;
  const id = (args as { id?: unknown }).id;
  return typeof id === "string" ? canonicalDagId(id) : undefined;
}
