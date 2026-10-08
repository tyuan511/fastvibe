import { useEffect } from "react";
import { create } from "zustand";
import type { DagGraph } from "@shared/dag";
import { watchDagGraphs } from "@/lib/dag-sync";

/** What the maximised graph dialog shows: whose graph, which node, and which side of it. */
export type DagViewer = {
  conversationId: string;
  nodeId?: string;
  /** `detail`: what the node is and produced; `run`: its sub-agent's execution. */
  view: "detail" | "run";
};

/**
 * Every conversation's DAG of sub-agent tasks, as Main last said it, and the dialog that shows
 * one maximised.
 *
 * Main owns the graphs (`dag.json`) and sends the whole graph of a conversation after every
 * change, so this store never merges: what arrives replaces what is here.
 */
type DagState = {
  graphs: Record<string, DagGraph>;
  viewer: DagViewer | null;
  apply: (conversationId: string, graph: DagGraph | null) => void;
  replaceAll: (graphs: DagGraph[]) => void;
  /** Open the dialog on a conversation's graph, optionally on one node. */
  openViewer: (conversationId: string, nodeId?: string, view?: DagViewer["view"]) => void;
  selectNode: (nodeId: string, view?: DagViewer["view"]) => void;
  setView: (view: DagViewer["view"]) => void;
  closeViewer: () => void;
};

export const useDagStore = create<DagState>((set) => ({
  graphs: {},
  viewer: null,
  apply: (conversationId, graph) =>
    set((state) => {
      const graphs = { ...state.graphs };
      if (graph) graphs[conversationId] = graph;
      else delete graphs[conversationId];
      // A dialog on a graph that no longer exists has nothing to show.
      const viewer = !graph && state.viewer?.conversationId === conversationId ? null : state.viewer;
      return { graphs, viewer };
    }),
  replaceAll: (list) => set({ graphs: Object.fromEntries(list.map((graph) => [graph.conversationId, graph])) }),
  openViewer: (conversationId, nodeId, view = "detail") => set({ viewer: { conversationId, nodeId, view } }),
  selectNode: (nodeId, view) =>
    set((state) => (state.viewer ? { viewer: { ...state.viewer, nodeId, view: view ?? state.viewer.view } } : state)),
  setView: (view) => set((state) => (state.viewer ? { viewer: { ...state.viewer, view } } : state)),
  closeViewer: () => set({ viewer: null }),
}));

/** Keeps the store in step with Main: one read at mount, then every `dag_changed`. */
export function useDagSync(): void {
  useEffect(() => watchDagGraphs(window.fastvibe.dag, useDagStore.getState()), []);
}
