/**
 * Node positions for 设置 → 长期记忆 → 关系图.
 *
 * The force layout is deliberately kept as a pure module. React Flow owns the
 * viewport and interaction; this module only gives it stable starting positions.
 * Deterministic — the same graph always draws the same way, so reopening the view
 * does not reshuffle it — and pure, so it is tested without a DOM.
 */

export type LayoutPoint = { x: number; y: number };

/** The visual size of a memory card in the React Flow canvas. */
export const MEMORY_NODE_WIDTH = 224;
export const MEMORY_NODE_HEIGHT = 112;
const MEMORY_NODE_GAP_X = 32;
const MEMORY_NODE_GAP_Y = 28;

/** Padding kept around the unit square, so no node sits on the plot's edge. */
const PADDING = 0.06;

export function layoutGraph(
  nodeIds: string[],
  edges: Array<{ sourceId: string; targetId: string }>,
  options: { iterations?: number } = {},
): Map<string, LayoutPoint> {
  const positions = new Map<string, LayoutPoint>();
  const count = nodeIds.length;
  if (count === 0) return positions;
  if (count === 1) {
    positions.set(nodeIds[0], { x: 0.5, y: 0.5 });
    return positions;
  }

  const index = new Map(nodeIds.map((id, position) => [id, position]));
  // One spring per connected pair, whatever the number of edges between them.
  const pairs = new Set<string>();
  const springs: Array<[number, number]> = [];
  for (const edge of edges) {
    const a = index.get(edge.sourceId);
    const b = index.get(edge.targetId);
    if (a === undefined || b === undefined || a === b) continue;
    const key = a < b ? `${a}:${b}` : `${b}:${a}`;
    if (pairs.has(key)) continue;
    pairs.add(key);
    springs.push([a, b]);
  }

  // A golden-angle spiral in list order: spread out, and the same every time.
  const x = new Float64Array(count);
  const y = new Float64Array(count);
  for (let i = 0; i < count; i++) {
    const radius = 0.45 * Math.sqrt((i + 0.5) / count);
    const angle = i * 2.399963229728653;
    x[i] = 0.5 + radius * Math.cos(angle);
    y[i] = 0.5 + radius * Math.sin(angle);
  }

  const k = 0.9 / Math.sqrt(count);
  const iterations = options.iterations ?? (count > 150 ? 150 : 300);
  const dx = new Float64Array(count);
  const dy = new Float64Array(count);
  for (let step = 0; step < iterations; step++) {
    dx.fill(0);
    dy.fill(0);
    for (let i = 0; i < count; i++) {
      for (let j = i + 1; j < count; j++) {
        let ox = x[i] - x[j];
        let oy = y[i] - y[j];
        let distance = Math.hypot(ox, oy);
        if (distance < 1e-9) {
          // Coincident nodes: separate them along a fixed direction.
          ox = 1e-3 * ((i % 7) - 3 || 1);
          oy = 1e-3 * ((j % 5) - 2 || 1);
          distance = Math.hypot(ox, oy);
        }
        const force = (k * k) / distance;
        dx[i] += (ox / distance) * force;
        dy[i] += (oy / distance) * force;
        dx[j] -= (ox / distance) * force;
        dy[j] -= (oy / distance) * force;
      }
    }
    for (const [a, b] of springs) {
      const ox = x[a] - x[b];
      const oy = y[a] - y[b];
      const distance = Math.max(1e-9, Math.hypot(ox, oy));
      const force = (distance * distance) / k;
      dx[a] -= (ox / distance) * force;
      dy[a] -= (oy / distance) * force;
      dx[b] += (ox / distance) * force;
      dy[b] += (oy / distance) * force;
    }
    const temperature = 0.1 * (1 - step / iterations);
    for (let i = 0; i < count; i++) {
      dx[i] += (0.5 - x[i]) * k * 1.5;
      dy[i] += (0.5 - y[i]) * k * 1.5;
      const length = Math.hypot(dx[i], dy[i]);
      if (length < 1e-12) continue;
      const move = Math.min(length, temperature);
      x[i] += (dx[i] / length) * move;
      y[i] += (dy[i] / length) * move;
    }
  }

  // Fit the result into the padded unit square, keeping its aspect ratio.
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (let i = 0; i < count; i++) {
    minX = Math.min(minX, x[i]); maxX = Math.max(maxX, x[i]);
    minY = Math.min(minY, y[i]); maxY = Math.max(maxY, y[i]);
  }
  const span = Math.max(maxX - minX, maxY - minY, 1e-9);
  const scale = (1 - 2 * PADDING) / span;
  const offsetX = (1 - (maxX - minX) * scale) / 2;
  const offsetY = (1 - (maxY - minY) * scale) / 2;
  nodeIds.forEach((id, i) => {
    positions.set(id, { x: offsetX + (x[i] - minX) * scale, y: offsetY + (y[i] - minY) * scale });
  });
  return positions;
}

/**
 * Converts the unit-square force result into collision-free card positions.
 *
 * React Flow positions nodes by their top-left corner. A dense memory index can
 * contain hundreds of cards, so merely scaling the force result into a fixed
 * rectangle would make cards overlap. We assign each node to the nearest free
 * slot in a roomy grid instead. The force result still determines the ordering
 * and keeps connected clusters together, while the grid gives a hard no-overlap
 * guarantee without a DOM measurement pass.
 */
export function layoutMemoryCards(
  nodeIds: string[],
  edges: Array<{ sourceId: string; targetId: string }>,
  options: { iterations?: number } = {},
): Map<string, LayoutPoint> {
  const result = new Map<string, LayoutPoint>();
  if (nodeIds.length === 0) return result;

  const force = layoutGraph(nodeIds, edges, options);
  if (nodeIds.length === 1) {
    result.set(nodeIds[0], { x: 0, y: 0 });
    return result;
  }

  const columns = Math.max(1, Math.ceil(Math.sqrt(nodeIds.length * 1.35)));
  const rows = Math.ceil(nodeIds.length / columns);
  const stepX = MEMORY_NODE_WIDTH + MEMORY_NODE_GAP_X;
  const stepY = MEMORY_NODE_HEIGHT + MEMORY_NODE_GAP_Y;
  const slots = Array.from({ length: nodeIds.length }, (_, index) => ({
    x: (index % columns) * stepX,
    y: Math.floor(index / columns) * stepY,
  }));

  // Place nodes in force-layout order, choosing the closest still-free slot.
  // Ties are resolved by node id so a graph with equal coordinates is stable too.
  const ordered = [...nodeIds].sort((a, b) => {
    const left = force.get(a) ?? { x: 0.5, y: 0.5 };
    const right = force.get(b) ?? { x: 0.5, y: 0.5 };
    return left.y - right.y || left.x - right.x || a.localeCompare(b);
  });
  const free = new Set(slots.map((_, index) => index));
  for (const id of ordered) {
    const point = force.get(id) ?? { x: 0.5, y: 0.5 };
    let best = -1;
    let bestDistance = Infinity;
    for (const index of free) {
      const slotX = columns === 1 ? 0.5 : (index % columns) / (columns - 1);
      const slotY = rows === 1 ? 0.5 : Math.floor(index / columns) / (rows - 1);
      const distance = (slotX - point.x) ** 2 + (slotY - point.y) ** 2;
      if (distance < bestDistance || (distance === bestDistance && index < best)) {
        best = index;
        bestDistance = distance;
      }
    }
    if (best < 0) continue;
    free.delete(best);
    result.set(id, slots[best]);
  }
  return result;
}
