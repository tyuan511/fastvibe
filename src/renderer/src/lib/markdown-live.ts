/**
 * How often a growing markdown block may be re-parsed while it streams.
 *
 * `splitMarkdownBlocks` bounds the cost of a long answer by parsing only the block being
 * written, but one block can still be large: a tight list, a table or a paragraph with no
 * blank line cannot be cut, and the pipeline costs roughly 1 ms per KB of it (measured: 10 ms
 * at 16 KB, 57 ms at 64 KB). Re-parsing that at the 32 ms flush cadence spends most of the
 * renderer's time redrawing text the reader has already seen.
 *
 * Small blocks — nearly all of them — stay real time. Above the threshold the interval grows
 * with the block so the parse holds a bounded share of the time (≈ 4× its own cost), and it is
 * capped so the text never looks stuck. A settled block never changes, so this only ever
 * delays the one block in flight; its final text always lands.
 */
export const LIVE_PARSE_THRESHOLD_CHARS = 4 * 1024;
const MS_PER_KB = 4;
const MAX_INTERVAL_MS = 400;

export function liveParseInterval(length: number): number {
  if (length < LIVE_PARSE_THRESHOLD_CHARS) return 0;
  return Math.min(MAX_INTERVAL_MS, Math.round((length / 1024) * MS_PER_KB));
}

/**
 * Decide whether a new version of a block may be shown now.
 *
 * Measured from the last *shown* version, not from the last token, so a stream that never
 * pauses still updates on schedule — a trailing debounce would starve it.
 */
export function mayShowLive(length: number, lastShownAt: number, now: number): boolean {
  const interval = liveParseInterval(length);
  return interval === 0 || now - lastShownAt >= interval;
}
