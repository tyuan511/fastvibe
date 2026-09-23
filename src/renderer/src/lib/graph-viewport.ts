/**
 * Pan and zoom for 设置 → 长期记忆 → 关系图, as axis domains.
 *
 * The graph is a recharts scatter plot, so the view is simply the X/Y axis domains in
 * layout units: zooming narrows them around the pointer, panning shifts them, and
 * recharts redraws nodes and edges on the new scales. Node and stroke sizes are in
 * pixels, so zooming spreads a crowded cluster apart instead of magnifying it. The Y
 * axis is drawn reversed, so data and screen agree that y grows downward.
 */

export type GraphView = { x0: number; x1: number; y0: number; y1: number };
export type PlotSize = { width: number; height: number };

/** Narrowest and widest span a view may have, in layout units (the layout fills [0, 1]). */
export const MIN_SPAN = 0.02;
export const MAX_SPAN = 6;

/** The layout point under a pixel of the plot area (origin at its top-left). */
export function pixelToData(view: GraphView, size: PlotSize, px: number, py: number): { x: number; y: number } {
  return {
    x: view.x0 + (px / Math.max(1, size.width)) * (view.x1 - view.x0),
    y: view.y0 + (py / Math.max(1, size.height)) * (view.y1 - view.y0),
  };
}

/**
 * The view that shows `bounds` whole, centred, with the plot's aspect ratio — so the
 * layout is never stretched — and a margin so no node sits on the edge.
 */
export function fitView(size: PlotSize, bounds: GraphView = { x0: 0, x1: 1, y0: 0, y1: 1 }, margin = 0.04): GraphView {
  const aspect = Math.max(1, size.width) / Math.max(1, size.height);
  let spanX = Math.max(bounds.x1 - bounds.x0, MIN_SPAN) + 2 * margin;
  let spanY = Math.max(bounds.y1 - bounds.y0, MIN_SPAN) + 2 * margin;
  if (spanX / spanY < aspect) spanX = spanY * aspect;
  else spanY = spanX / aspect;
  const cx = (bounds.x0 + bounds.x1) / 2;
  const cy = (bounds.y0 + bounds.y1) / 2;
  return { x0: cx - spanX / 2, x1: cx + spanX / 2, y0: cy - spanY / 2, y1: cy + spanY / 2 };
}

/** The bounding box of a set of points, or the unit square when there are none. */
export function boundsOf(points: Iterable<{ x: number; y: number }>): GraphView {
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const point of points) {
    x0 = Math.min(x0, point.x); x1 = Math.max(x1, point.x);
    y0 = Math.min(y0, point.y); y1 = Math.max(y1, point.y);
  }
  return Number.isFinite(x0) ? { x0, x1, y0, y1 } : { x0: 0, x1: 1, y0: 0, y1: 1 };
}

/**
 * Zoom by `factor` (< 1 zooms in) keeping the layout point under (px, py) where it is.
 * A zoom that would pass the span limits stops at them, still anchored.
 */
export function zoomAt(view: GraphView, size: PlotSize, factor: number, px: number, py: number): GraphView {
  const spanX = view.x1 - view.x0;
  const spanY = view.y1 - view.y0;
  const limited = Math.min(Math.max(factor, MIN_SPAN / Math.min(spanX, spanY)), MAX_SPAN / Math.max(spanX, spanY));
  const anchor = pixelToData(view, size, px, py);
  return {
    x0: anchor.x - (anchor.x - view.x0) * limited,
    x1: anchor.x + (view.x1 - anchor.x) * limited,
    y0: anchor.y - (anchor.y - view.y0) * limited,
    y1: anchor.y + (view.y1 - anchor.y) * limited,
  };
}

/** Move the content by (dx, dy) pixels: dragging right shows what was to the left. */
export function panBy(view: GraphView, size: PlotSize, dx: number, dy: number): GraphView {
  const ox = (dx / Math.max(1, size.width)) * (view.x1 - view.x0);
  const oy = (dy / Math.max(1, size.height)) * (view.y1 - view.y0);
  return { x0: view.x0 - ox, x1: view.x1 - ox, y0: view.y0 - oy, y1: view.y1 - oy };
}

/** How far the view is zoomed relative to `base`, as a percentage for display. */
export function zoomPercent(view: GraphView, base: GraphView): number {
  return Math.round(((base.x1 - base.x0) / (view.x1 - view.x0)) * 100);
}

/** The wheel's zoom factor: a trackpad's small deltas and a mouse's large steps both feel even. */
export function wheelFactor(deltaY: number, deltaMode: number): number {
  const pixels = deltaMode === 1 ? deltaY * 16 : deltaMode === 2 ? deltaY * 400 : deltaY;
  return Math.exp(Math.max(-1, Math.min(1, pixels * 0.0015)));
}
