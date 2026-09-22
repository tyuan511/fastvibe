import { useCallback, useRef } from "react";

/**
 * One identity for a callback that is rebuilt every render.
 *
 * `App` is the shell, and the handlers it hands to the sidebar and the right pane are
 * plain function declarations closing over its render — a fresh identity each time,
 * which is what kept `memo` from ever holding those subtrees still. `useCallback` on
 * the handlers themselves would mean dependency lists on closures that read a dozen
 * pieces of App state, and a missing one is a stale click rather than a slow render.
 *
 * This keeps the wrapper's identity fixed and the *call* current: the ref is updated
 * on every render, so the wrapper always invokes the newest closure. Use it for
 * handlers whose identity is noise; never for a value a child should re-render on.
 */
export function useStable<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
  const latest = useRef(fn);
  latest.current = fn;
  return useCallback((...args: A) => latest.current(...args), []);
}
