import { useEffect, useRef, useState } from "react";
import type { GitStatus } from "@shared/ipc";

/**
 * Git status is read through a tiny cache because several surfaces want it at
 * once (the composer branch chip, the 审查 pane) and each read spawns a `git`
 * process in the main process. Entries are short-lived: the timestamp only
 * exists to collapse bursts (a remount, a focus event right after a read).
 */
const TTL = 4_000;
const POLL_MS = 10_000;
/**
 * Ceiling for the poll once a workspace has gone quiet.
 *
 * Every tick spawns `git status --porcelain --untracked-files=all` in Main, which on a
 * large repository walks the whole working tree — a fixed ten-second beat means that
 * walk runs forever behind a window nobody is editing in. Consecutive identical reads
 * double the wait up to this, and anything that can plausibly have changed the tree —
 * a finished turn, a focus, a change in the answer itself — puts it straight back to
 * `POLL_MS`.
 */
const MAX_POLL_MS = 60_000;

/** What a status says, for "did anything change since the last read?". */
function signature(status: GitStatus): string {
  return [
    status.branch ?? "",
    status.changed,
    status.staged,
    status.additions,
    status.deletions,
    status.ahead ?? 0,
    status.behind ?? 0,
    status.files.map((file) => `${file.index}${file.worktree}${file.path}`).join(","),
  ].join("|");
}

const cache = new Map<string, { at: number; status: GitStatus }>();
const inflight = new Map<string, Promise<GitStatus>>();

function emptyStatus(cwd: string): GitStatus {
  return { cwd, isRepository: false, changed: 0, staged: 0, additions: 0, deletions: 0, files: [] };
}

export async function readGitStatus(cwd: string, force = false): Promise<GitStatus> {
  const cached = cache.get(cwd);
  if (!force && cached && Date.now() - cached.at < TTL) return cached.status;
  const pending = inflight.get(cwd);
  if (pending) return pending;
  const request = window.fastvibe.workspace
    .gitStatus(cwd)
    .then((status) => {
      cache.set(cwd, { at: Date.now(), status });
      return status;
    })
    .catch(() => cached?.status ?? emptyStatus(cwd))
    .finally(() => {
      inflight.delete(cwd);
    });
  inflight.set(cwd, request);
  return request;
}

/**
 * Git status for a workspace, fresh enough to drive the composer's branch chip:
 * refetched on window focus, whenever `refreshKey` changes (pass the streaming
 * flag so a finished turn re-reads), and on a slow interval. `null` until the
 * first read resolves, and when no workspace is bound.
 */
export function useGitStatus(cwd?: string, refreshKey?: unknown): GitStatus | null {
  const [status, setStatus] = useState<GitStatus | null>(() =>
    cwd ? cache.get(cwd)?.status ?? null : null,
  );
  const cwdRef = useRef(cwd);
  const keyRef = useRef(refreshKey);

  useEffect(() => {
    if (!cwd) {
      setStatus(null);
      return;
    }
    let cancelled = false;
    let wait = POLL_MS;
    let last = "";
    let timer = 0;
    const load = (force: boolean): void => {
      void readGitStatus(cwd, force).then((next) => {
        if (cancelled) return;
        const next_ = signature(next);
        // A tree that answered the same thing twice is a tree nobody is editing.
        wait = next_ === last ? Math.min(wait * 2, MAX_POLL_MS) : POLL_MS;
        last = next_;
        setStatus(next);
      });
    };
    /** A read that also restarts the beat, for anything that means "look now". */
    const refresh = (): void => {
      wait = POLL_MS;
      load(true);
      schedule();
    };
    const schedule = (): void => {
      window.clearTimeout(timer);
      // A hidden window has nobody to show the result to, so it polls for as long as
      // the app is left open in the background — skip those ticks, and take one read
      // on the way back so the chip is never stale by a whole interval.
      timer = window.setTimeout(() => {
        if (!document.hidden) load(true);
        schedule();
      }, wait);
    };
    // A new workspace, or a `refreshKey` flip (a finished turn), bypasses the
    // cache. Otherwise a read that just happened is reused — a sibling surface
    // or a remount should not spawn a second `git` process.
    const force = cwdRef.current !== cwd || keyRef.current !== refreshKey;
    cwdRef.current = cwd;
    keyRef.current = refreshKey;
    load(force || !cache.has(cwd));
    schedule();
    const onFocus = (): void => refresh();
    const onVisible = (): void => {
      if (!document.hidden) refresh();
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [cwd, refreshKey]);

  // Ignore a status read for a workspace we have since left, so the chip never
  // flashes a stale branch while the new one is in flight.
  return cwd && status?.cwd === cwd ? status : null;
}
