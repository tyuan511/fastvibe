import type { Me } from "./api";

/**
 * Whether this browser is signed in, remembered between page loads.
 *
 * The marketing pages are static and the session cookie is HttpOnly, so the page cannot
 * know who is looking until it asks /api/me, a round trip after first paint. Without a
 * hint, every signed-in visitor would see "Sign in" for that moment before it turns into
 * their avatar. So the last answer is kept here and drawn immediately; the real answer
 * replaces it a moment later. It holds only a login name and a public avatar URL, never a
 * credential, and being wrong costs one corrected frame, not access to anything.
 */
export type Viewer = { login: string; avatar: string | null };

const KEY = "fastvibe-viewer";

/** `undefined`: nothing remembered. `null`: remembered as signed out. */
export function readViewerHint(): Viewer | null | undefined {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw === null) return undefined;
    if (raw === "anonymous") return null;
    const value = JSON.parse(raw) as { login?: unknown; avatar?: unknown };
    if (typeof value.login === "string") {
      return { login: value.login, avatar: typeof value.avatar === "string" ? value.avatar : null };
    }
  } catch {
    // storage may be blocked, or the value damaged: treat both as nothing remembered
  }
  return undefined;
}

export function writeViewerHint(me: Me | null): void {
  try {
    localStorage.setItem(KEY, me ? JSON.stringify({ login: me.login, avatar: me.avatar_url }) : "anonymous");
  } catch {
    // storage may be blocked; the hint is only an optimisation
  }
}
