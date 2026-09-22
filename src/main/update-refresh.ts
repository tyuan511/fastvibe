/**
 * Whether a download should re-resolve the newest release first.
 *
 * `autoUpdater.downloadUpdate()` downloads the version the *last check* resolved —
 * the metadata is cached in `updateInfoAndProvider` and nothing in the SDK re-reads
 * the feed. With `autoDownload` off that gap is unbounded: the background check finds
 * a version, the user reads the notes at their leisure, and 立即更新 downloads whatever
 * was newest when the check ran. If a release landed in between, the install finishes
 * on a version that is already superseded — the app relaunches, checks, finds the next
 * one, and shows 更新 again immediately. Two restarts for one release, with nothing on
 * screen to explain the second.
 *
 * So a click re-checks before it downloads. It is not unconditional: a finding seconds
 * old is worth trusting, and every press would otherwise pay a round trip before the
 * progress bar moves. `LAST_CHECK_AT` is what tells the two apart.
 */

/** How long a found version is trusted without asking the feed again. */
export const UPDATE_RECHECK_AFTER_MS = 60_000;

export type UpdateRecheckInput = {
  /** The version the last check resolved; absent when there is nothing to download. */
  version: string | undefined;
  /** When that version was resolved, epoch ms; 0 when no check has answered yet. */
  checkedAt: number;
  now: number;
  recheckAfterMs?: number;
};

/**
 * True when the feed must be read again before downloading. A missing version is not a
 * reason to skip — there is nothing to download, and the caller re-checks to find out
 * whether that is still so (a release can be deleted between the notice and the click).
 */
export function shouldRecheckBeforeDownload(input: UpdateRecheckInput): boolean {
  if (!input.version) return true;
  const window = input.recheckAfterMs ?? UPDATE_RECHECK_AFTER_MS;
  return input.now - input.checkedAt >= window;
}
