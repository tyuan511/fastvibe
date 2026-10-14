/**
 * Line-number boxes for the file editor's gutter.
 *
 * The textarea is the scroller. Numbers are drawn only for the lines that
 * intersect the viewport (plus a little overscan) and positioned in the gutter's
 * own coordinate space — content position minus `scrollTop` — so a wide line can
 * scroll sideways without taking the numbers with it. `heights` is one entry per
 * logical line when soft-wrap is on; null means every line is `lineHeight` tall.
 */
export interface GutterMetrics {
  lineHeight: number;
  paddingTop: number;
}

export interface GutterSpan {
  /** Zero-based line index. The gutter prints `index + 1`. */
  index: number;
  /** Top of the line box, in the gutter's visible box (already minus scroll). */
  top: number;
  height: number;
}

export function gutterSpans(
  scrollTop: number,
  viewport: number,
  lineCount: number,
  metrics: GutterMetrics,
  heights: readonly number[] | null = null,
  overscan = 2,
): GutterSpan[] {
  if (lineCount <= 0 || viewport <= 0) return [];
  const { lineHeight, paddingTop } = metrics;
  if (heights) {
    if (heights.length !== lineCount) return [];
    return variableSpans(scrollTop, viewport, paddingTop, lineHeight, heights, overscan);
  }
  if (!(lineHeight > 0)) return [];
  const first = Math.floor((scrollTop - paddingTop) / lineHeight);
  const last = Math.ceil((scrollTop + viewport - paddingTop) / lineHeight) - 1;
  const start = Math.max(0, first - overscan);
  const end = Math.min(lineCount - 1, last + overscan);
  if (end < start) return [];
  const spans: GutterSpan[] = [];
  for (let index = start; index <= end; index++) {
    spans.push({
      index,
      top: paddingTop + index * lineHeight - scrollTop,
      height: lineHeight,
    });
  }
  return spans;
}

function variableSpans(
  scrollTop: number,
  viewport: number,
  paddingTop: number,
  lineHeight: number,
  heights: readonly number[],
  overscan: number,
): GutterSpan[] {
  const lineCount = heights.length;
  const sums = new Array<number>(lineCount + 1);
  sums[0] = 0;
  for (let index = 0; index < lineCount; index++) {
    const height = heights[index] > 0 ? heights[index] : lineHeight;
    sums[index + 1] = sums[index] + height;
  }
  const viewTop = scrollTop - paddingTop;
  const viewBottom = viewTop + viewport;
  if (sums[lineCount] <= viewTop || viewBottom <= 0) return [];

  let lo = 0;
  let hi = lineCount - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sums[mid + 1] <= viewTop) lo = mid + 1;
    else hi = mid;
  }
  if (sums[lo + 1] <= viewTop || sums[lo] >= viewBottom) return [];
  const first = lo;

  lo = first;
  hi = lineCount - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (sums[mid] < viewBottom) lo = mid;
    else hi = mid - 1;
  }
  const start = Math.max(0, first - overscan);
  const end = Math.min(lineCount - 1, lo + overscan);
  const spans: GutterSpan[] = [];
  for (let index = start; index <= end; index++) {
    spans.push({
      index,
      top: paddingTop + sums[index] - scrollTop,
      height: sums[index + 1] - sums[index],
    });
  }
  return spans;
}
