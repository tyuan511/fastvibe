/**
 * Whether a scroll event came from the transcript itself rather than from the reader.
 *
 * Follow-the-bottom and the reader's own scrolling are two writers of one `scrollTop`,
 * and "we are scrolling right now" is not enough to tell them apart: while a reply
 * streams the follow effect scrolls on *every* flush, so a flag that is set for the
 * duration of a programmatic scroll is set almost all the time. The reader's wheel is
 * then read as the list's own scroll, follow mode never drops, and the next flush pulls
 * the viewport back to the bottom under their thumb — the whole thread shivers.
 *
 * A position instead. Every scroll the list performs records where it started and where
 * it put the viewport; a scroll event landing between those (or on the target) is ours,
 * and anything else is the reader's. A wheel that fights a follow scroll moves away from
 * the target on its first event, so intent registers immediately.
 */
export type ScrollMark = {
  /** `scrollTop` when the list started scrolling. */
  from: number;
  /** `scrollTop` the list asked for. */
  target: number;
  /** When it asked, in `Date.now()` milliseconds. */
  at: number;
};

/** Sub-pixel drift is not a different position. */
export const SCROLL_MARK_SLACK = 2;
/** How long a mark may explain a scroll event at all (a jump still settling). */
export const SCROLL_MARK_TTL_MS = 500;

/**
 * The mark for a scroll from `from` to `target`, or `null` when nothing moved — a scroll
 * that does not move the viewport explains nothing, and must not be able to claim the
 * reader's next one.
 */
export function scrollMark(from: number, target: number, now: number): ScrollMark | null {
  if (Math.abs(target - from) <= SCROLL_MARK_SLACK) return null;
  return { from, target, at: now };
}

export function isProgrammaticScroll(
  mark: ScrollMark | null,
  scrollTop: number,
  now: number,
): boolean {
  if (!mark) return false;
  if (now - mark.at > SCROLL_MARK_TTL_MS) return false;
  const low = Math.min(mark.from, mark.target) - SCROLL_MARK_SLACK;
  const high = Math.max(mark.from, mark.target) + SCROLL_MARK_SLACK;
  return scrollTop >= low && scrollTop <= high;
}
