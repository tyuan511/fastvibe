import { useEffect, useMemo, useState } from "react";
import { collectPathCandidates } from "./remark-path-links";

const MAX_CANDIDATES = 512;
const MAX_PATH_LENGTH = 4096;
const CACHE_TTL_MS = 30_000;
const BATCH_SIZE = 128;
const EMPTY = new Set<string>();

type CacheEntry = { value: boolean; expiresAt: number };
type Waiter = { resolve: (value: boolean) => void; reject: () => void };
type Pending = { path: string; cwd?: string; waiters: Waiter[] };

// The cache is shared by every Markdown block and every message. A streamed answer
// commonly repeats the same paths, so this keeps the normal case to zero IPC calls.
const cache = new Map<string, CacheEntry>();
const pending = new Map<string, Pending>();
let flushScheduled = false;

function cacheKey(path: string, cwd?: string): string {
  return `${cwd ?? ""}\u0000${path}`;
}

function scheduleFlush(): void {
  if (flushScheduled) return;
  flushScheduled = true;
  queueMicrotask(() => {
    flushScheduled = false;
    void flushPending();
  });
}

async function flushPending(): Promise<void> {
  if (pending.size === 0) return;
  const first = pending.values().next().value as Pending | undefined;
  if (!first) return;
  // A cwd is part of the request because it is also the routing key for a remote
  // workspace. Grouping by cwd lets one call cover many candidates without mixing
  // files that belong to different App Servers.
  const group = [...pending.values()]
    .filter((item) => item.cwd === first.cwd)
    .slice(0, BATCH_SIZE);
  const keys = group.map((item) => cacheKey(item.path, item.cwd));
  for (const key of keys) pending.delete(key);
  try {
    const existing = new Set(await window.fastvibe.workspace.filesExist(group.map((item) => item.path), first.cwd));
    const now = Date.now();
    for (const item of group) {
      const value = existing.has(item.path);
      cache.set(cacheKey(item.path, item.cwd), { value, expiresAt: now + CACHE_TTL_MS });
      for (const waiter of item.waiters) waiter.resolve(value);
    }
  } catch {
    // A disconnected remote client must render plain text, and may retry after the
    // socket reconnects. Do not cache this transport failure as a real negative.
    for (const item of group) for (const waiter of item.waiters) waiter.reject();
  }
  if (pending.size > 0) scheduleFlush();
}

function ensurePath(path: string, cwd?: string): Promise<boolean> {
  const key = cacheKey(path, cwd);
  const entry = cache.get(key);
  if (entry && entry.expiresAt > Date.now()) return Promise.resolve(entry.value);
  if (entry) cache.delete(key);
  const queued = pending.get(key);
  if (queued) {
    return new Promise<boolean>((resolve, reject) => queued.waiters.push({ resolve, reject }));
  }
  return new Promise<boolean>((resolve, reject) => {
    pending.set(key, { path, cwd, waiters: [{ resolve, reject }] });
    scheduleFlush();
  });
}

/** Validate a bounded, deduplicated set of Markdown candidates in one or more IPC batches. */
export async function validateMarkdownPaths(candidates: string[], cwd?: string): Promise<Set<string>> {
  const unique = [...new Set(candidates)].filter((path) => path.length <= MAX_PATH_LENGTH).slice(0, MAX_CANDIDATES);
  const query = unique.filter((path) => /^([a-zA-Z]:)?\//.test(path) || Boolean(cwd));
  if (query.length === 0) return new Set();
  const values = await Promise.all(query.map((path) => ensurePath(path, cwd)));
  const valid = new Set<string>();
  query.forEach((path, index) => {
    if (values[index]) valid.add(path);
  });
  return valid;
}

/** React hook used by each settled Markdown block. Results are shared across blocks. */
export function useValidatedMarkdownPaths(text: string, cwd?: string): ReadonlySet<string> {
  const candidates = useMemo(() => collectPathCandidates(text), [text]);
  const [valid, setValid] = useState<ReadonlySet<string>>(EMPTY);
  const key = `${cwd ?? ""}\u0000${candidates.join("\u0000")}`;
  useEffect(() => {
    let cancelled = false;
    if (candidates.length === 0) {
      setValid(EMPTY);
      return () => { cancelled = true; };
    }
    setValid(EMPTY);
    void validateMarkdownPaths(candidates, cwd).then((next) => {
      if (!cancelled) setValid(next);
    }).catch(() => {
      if (!cancelled) setValid(EMPTY);
    });
    return () => { cancelled = true; };
  }, [key]);
  return valid;
}
