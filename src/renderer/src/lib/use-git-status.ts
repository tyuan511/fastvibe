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
export function gitStatusSignature(status: GitStatus): string {
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

type Listener = (status: GitStatus) => void;
type Watch = { listeners: Set<Listener>; wait: number; last: string; timer: number };
const watches = new Map<string, Watch>();
let globalHandlersInstalled = false;

/**
 * One poller per workspace, shared by everything that shows its status.
 *
 * The composer's branch chip, the resources panel, the file tree and the git pane each used to
 * keep their own timer, and each timer forced a read past the cache — N surfaces on one
 * workspace meant N `git status` + `git diff --numstat` rounds per beat, and the slow-call log
 * shows them arriving in pairs. Now the first subscriber starts the beat, later ones join it,
 * and the last one out stops it. The backoff, the hidden-window pause and the focus refresh are
 * one copy, applied to every subscriber at once.
 */
export function subscribeGitStatus(cwd: string, listener: Listener): () => void {
  let watch = watches.get(cwd);
  if (!watch) {
    watch = { listeners: new Set(), wait: POLL_MS, last: "", timer: 0 };
    watches.set(cwd, watch);
  }
  watch.listeners.add(listener);
  installGlobalHandlers();
  const cached = cache.get(cwd);
  if (cached) listener(cached.status);
  // The first listener reads (a read that just happened is reused through the cache); a later
  // one is told by the next result, or by the cache above.
  if (watch.listeners.size === 1) {
    load(cwd, !cached);
    schedule(cwd);
  } else if (!cached) {
    void readGitStatus(cwd).then((status) => listener(status));
  }
  return () => {
    const current = watches.get(cwd);
    if (!current) return;
    current.listeners.delete(listener);
    if (current.listeners.size === 0) {
      window.clearTimeout(current.timer);
      watches.delete(cwd);
    }
  };
}

function load(cwd: string, force: boolean): void {
  void readGitStatus(cwd, force).then((next) => {
    const watch = watches.get(cwd);
    if (!watch) return;
    const sig = gitStatusSignature(next);
    // A tree that answered the same thing twice is a tree nobody is editing.
    watch.wait = sig === watch.last ? Math.min(watch.wait * 2, MAX_POLL_MS) : POLL_MS;
    watch.last = sig;
    for (const listener of [...watch.listeners]) listener(next);
  });
}

function schedule(cwd: string): void {
  const watch = watches.get(cwd);
  if (!watch) return;
  window.clearTimeout(watch.timer);
  // A hidden window has nobody to show the result to: skip the tick, and take one read on the
  // way back (`installGlobalHandlers`) so nothing is stale by a whole interval.
  watch.timer = window.setTimeout(() => {
    if (!document.hidden) load(cwd, true);
    schedule(cwd);
  }, watch.wait);
}

/** Read every watched workspace now and restart its beat: anything that means "look now". */
export function refreshGitStatus(cwd?: string): void {
  for (const [key, watch] of watches) {
    if (cwd && key !== cwd) continue;
    watch.wait = POLL_MS;
    load(key, true);
    schedule(key);
  }
}

function installGlobalHandlers(): void {
  if (globalHandlersInstalled || typeof window === "undefined") return;
  globalHandlersInstalled = true;
  window.addEventListener("focus", () => refreshGitStatus());
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) refreshGitStatus();
  });
}

/**
 * Git status for a workspace, fresh enough to drive the composer's branch chip:
 * refetched on window focus, whenever `refreshKey` changes (pass the streaming
 * flag so a finished turn re-reads), and on a slow shared interval. `null` until the
 * first read resolves, and when no workspace is bound.
 */
export function useGitStatus(cwd?: string, refreshKey?: unknown): GitStatus | null {
  const [status, setStatus] = useState<GitStatus | null>(() =>
    cwd ? cache.get(cwd)?.status ?? null : null,
  );
  const keyRef = useRef(refreshKey);

  useEffect(() => {
    if (!cwd) {
      setStatus(null);
      return;
    }
    return subscribeGitStatus(cwd, setStatus);
  }, [cwd]);

  // A flipped `refreshKey` (a finished turn) bypasses the cache; the first render does not.
  useEffect(() => {
    if (keyRef.current === refreshKey) return;
    keyRef.current = refreshKey;
    if (cwd) refreshGitStatus(cwd);
  }, [cwd, refreshKey]);

  // Ignore a status read for a workspace we have since left, so the chip never
  // flashes a stale branch while the new one is in flight.
  return cwd && status?.cwd === cwd ? status : null;
}
