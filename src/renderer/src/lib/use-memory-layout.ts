import { useEffect, useState } from "react";
import LayoutWorker from "./memory-graph-layout.worker?worker";
import { layoutGraph, type LayoutPoint, type MemoryLayoutResponse } from "./memory-graph-layout";

export type MemoryLayoutInput = {
  nodeIds: string[];
  edges: Array<{ sourceId: string; targetId: string }>;
};

/**
 * Force-directed positions for the memory graph, computed off the main thread.
 *
 * `null` means a layout is still running (or there is nothing to lay out yet).
 * An empty graph resolves immediately. If the worker cannot start — a packaged
 * `file://` window that refuses it, for instance — the same pure function runs
 * here so the graph still appears.
 */
export function useMemoryLayout(input: MemoryLayoutInput | null): Map<string, LayoutPoint> | null {
  const [ready, setReady] = useState<{ input: MemoryLayoutInput; positions: Map<string, LayoutPoint> } | null>(null);

  useEffect(() => {
    if (!input) return;
    if (input.nodeIds.length === 0) {
      setReady({ input, positions: new Map() });
      return;
    }
    let alive = true;
    let settled = false;
    const finish = (positions: Map<string, LayoutPoint>): void => {
      if (!alive || settled) return;
      settled = true;
      setReady({ input, positions });
    };
    const fallback = (): void => finish(layoutGraph(input.nodeIds, input.edges));
    let worker: Worker;
    try {
      worker = new LayoutWorker();
    } catch {
      fallback();
      return;
    }
    worker.onmessage = (event: MessageEvent<MemoryLayoutResponse>) => {
      if (event.data.id !== 1) return;
      if (event.data.error || !event.data.positions) fallback();
      else finish(new Map(event.data.positions));
    };
    worker.onerror = () => fallback();
    worker.postMessage({ id: 1, nodeIds: input.nodeIds, edges: input.edges });
    return () => {
      alive = false;
      worker.terminate();
    };
  }, [input]);

  if (!input || ready?.input !== input) return null;
  return ready.positions;
}
