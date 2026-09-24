import { layoutGraph, type MemoryLayoutRequest, type MemoryLayoutResponse } from "./memory-graph-layout";

// The renderer tsconfig has the DOM lib, which does not include the worker
// global. The cast is the dedicated-worker scope this file actually runs in.
const scope = self as unknown as {
  onmessage: ((event: MessageEvent<MemoryLayoutRequest>) => void) | null;
  postMessage(message: MemoryLayoutResponse): void;
};

scope.onmessage = (event: MessageEvent<MemoryLayoutRequest>): void => {
  const { id, nodeIds, edges } = event.data;
  try {
    const positions = layoutGraph(nodeIds, edges);
    const response: MemoryLayoutResponse = { id, positions: [...positions] };
    scope.postMessage(response);
  } catch (cause) {
    const response: MemoryLayoutResponse = { id, error: cause instanceof Error ? cause.message : String(cause) };
    scope.postMessage(response);
  }
};
