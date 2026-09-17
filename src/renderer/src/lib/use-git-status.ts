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

const cache = new Map<string, { at: number; status: GitStatus }>();
const inflight = new Map<string, Promise<GitStatus>>();

function emptyStatus(cwd: string): GitStatus {
  return { cwd, isRepository: false, changed: 0, staged: 0, files: [] };
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
    const load = (force: boolean): void => {
      void readGitStatus(cwd, force).then((next) => {
        if (!cancelled) setStatus(next);
      });
    };
    // A new workspace, or a `refreshKey` flip (a finished turn), bypasses the
    // cache. Otherwise a read that just happened is reused — a sibling surface
    // or a remount should not spawn a second `git` process.
    const force = cwdRef.current !== cwd || keyRef.current !== refreshKey;
    cwdRef.current = cwd;
    keyRef.current = refreshKey;
    load(force || !cache.has(cwd));
    // Every tick spawns a `git` process in Main. A hidden window has nobody to show
    // the result to, so it polls for as long as the app is left open in the
    // background — skip those ticks, and take one read on the way back so the chip
    // is never stale by a whole interval.
    const timer = window.setInterval(() => {
      if (!document.hidden) load(true);
    }, POLL_MS);
    const onFocus = (): void => load(true);
    const onVisible = (): void => {
      if (!document.hidden) load(true);
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [cwd, refreshKey]);

  // Ignore a status read for a workspace we have since left, so the chip never
  // flashes a stale branch while the new one is in flight.
  return cwd && status?.cwd === cwd ? status : null;
}
