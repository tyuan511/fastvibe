import type { DagGraph } from "../../../shared/dag.ts";

type DagChange = { conversationId: string; graph: DagGraph | null };
type DagSource = {
  list(): Promise<DagGraph[]>;
  onChanged(listener: (change: DagChange) => void): () => void;
};
type DagSink = {
  apply(conversationId: string, graph: DagGraph | null): void;
  replaceAll(graphs: DagGraph[]): void;
};

/** Subscribe first, then overlay every intervening push (including deletions) on the initial list. */
export function watchDagGraphs(source: DagSource, sink: DagSink): () => void {
  let disposed = false;
  let duringLoad: Map<string, DagGraph | null> | null = new Map();
  const off = source.onChanged(({ conversationId, graph }) => {
    if (disposed) return;
    duringLoad?.set(conversationId, graph);
    sink.apply(conversationId, graph);
  });
  void source.list().then((list) => {
    if (disposed) return;
    const graphs = new Map(list.map((graph) => [graph.conversationId, graph]));
    for (const [id, graph] of duringLoad ?? []) {
      if (graph) graphs.set(id, graph);
      else graphs.delete(id);
    }
    duringLoad = null;
    sink.replaceAll([...graphs.values()]);
  }).catch(() => {
    // A failed initial read must not discard the pushes already applied or stop live updates.
    duringLoad = null;
  });
  return () => {
    disposed = true;
    duringLoad = null;
    off();
  };
}
