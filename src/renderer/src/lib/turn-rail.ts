/**
 * The turn being read, from where the viewport actually is.
 *
 * The transcript is virtualised per turn, so only a handful of turns are mounted
 * and an observer over those elements can only ever see them: the oldest mounted
 * turn then wins, which is one or two turns above the one on screen. The
 * virtualizer already knows every turn's position, mounted or not, so the turn is
 * the last one whose prompt has reached the reading line.
 *
 * `offset` is the viewport's scroll position plus the line it reads at (the
 * scroller's own top inset); `starts` are the turns' positions in that same
 * coordinate, in order. A turn that has not been measured yet has no start and is
 * skipped, so a half-measured thread never lights a turn that is still a guess.
 */
export function activeTurnIndex(starts: ReadonlyArray<number | undefined>, offset: number): number {
  let next = -1;
  for (let index = 0; index < starts.length; index += 1) {
    const start = starts[index];
    if (start === undefined) continue;
    if (start <= offset) next = index;
    else break;
  }
  return next;
}
