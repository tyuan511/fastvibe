import type { DagNode } from "@shared/dag";

/**
 * Where each node of a graph is drawn.
 *
 * Layers run top to bottom — a side pane is narrow and tall — and a node's layer is the length
 * of the longest chain of dependencies above it, so every edge points down and nothing is ever
 * drawn before the nodes it waits on. Within a layer nodes are ordered by where their parents
 * sit (the barycentre of the parents' columns), which keeps most edges short and is enough to
 * stop a typical fan-out / fan-in from turning into a tangle. Positions are in layout units;
 * the view scales them.
 */
export type DagLayout = {
  /** Node id → its place: column and row index, and centre point in units. */
  positions: Map<string, { layer: number; column: number; x: number; y: number }>;
  /** How many columns the widest layer has. */
  columns: number;
  layers: number;
  width: number;
  height: number;
  edges: Array<{ from: string; to: string }>;
};

export const DAG_CELL = { width: 184, height: 68, gapX: 16, gapY: 40 } as const;

export function layoutDag(nodes: readonly DagNode[]): DagLayout {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const layerOf = new Map<string, number>();
  const visiting = new Set<string>();
  const depth = (id: string): number => {
    const known = layerOf.get(id);
    if (known !== undefined) return known;
    // A cycle cannot be created through the tools, but a hand-edited file must not hang the pane.
    if (visiting.has(id)) return 0;
    visiting.add(id);
    const node = byId.get(id);
    const deps = (node?.dependsOn ?? []).filter((dep) => byId.has(dep));
    const layer = deps.length === 0 ? 0 : 1 + Math.max(...deps.map(depth));
    visiting.delete(id);
    layerOf.set(id, layer);
    return layer;
  };
  for (const node of nodes) depth(node.id);

  const layers: string[][] = [];
  for (const node of nodes) {
    const layer = layerOf.get(node.id) ?? 0;
    (layers[layer] ??= []).push(node.id);
  }

  const column = new Map<string, number>();
  layers.forEach((ids, layerIndex) => {
    if (layerIndex === 0) {
      ids.forEach((id, index) => column.set(id, index));
      return;
    }
    const score = (id: string): number => {
      const parents = (byId.get(id)?.dependsOn ?? []).map((dep) => column.get(dep)).filter((value): value is number => value !== undefined);
      return parents.length === 0 ? Number.MAX_SAFE_INTEGER : parents.reduce((sum, value) => sum + value, 0) / parents.length;
    };
    const ordered = [...ids].sort((a, b) => score(a) - score(b));
    layers[layerIndex] = ordered;
    ordered.forEach((id, index) => column.set(id, index));
  });

  const columns = Math.max(1, ...layers.map((ids) => ids.length));
  const rowWidth = columns * DAG_CELL.width + (columns - 1) * DAG_CELL.gapX;
  const positions: DagLayout["positions"] = new Map();
  layers.forEach((ids, layerIndex) => {
    // Each layer is centred on the widest one, so a lone join node sits under its parents.
    const used = ids.length * DAG_CELL.width + (ids.length - 1) * DAG_CELL.gapX;
    const offset = (rowWidth - used) / 2;
    ids.forEach((id, index) => {
      positions.set(id, {
        layer: layerIndex,
        column: index,
        x: offset + index * (DAG_CELL.width + DAG_CELL.gapX) + DAG_CELL.width / 2,
        y: layerIndex * (DAG_CELL.height + DAG_CELL.gapY) + DAG_CELL.height / 2,
      });
    });
  });

  const edges = nodes.flatMap((node) => node.dependsOn.filter((dep) => byId.has(dep)).map((dep) => ({ from: dep, to: node.id })));
  const height = layers.length === 0 ? 0 : layers.length * DAG_CELL.height + (layers.length - 1) * DAG_CELL.gapY;
  return { positions, columns, layers: layers.length, width: rowWidth, height, edges };
}
