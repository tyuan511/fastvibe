/**
 * The phone page's two places, kept in the hash so the system back gesture (Android's
 * back button, iOS's edge swipe in a home-screen app) walks the chats the user visited.
 *
 * - `#/` or `#/new[/<cwd>]`   a new conversation, optionally in a project
 * - `#/c/<id>`                one conversation
 *
 * The conversation list is not a place: it is a drawer over whichever of these is on
 * screen, so opening it never costs the chat behind it.
 */
export type MobileRoute = { kind: "chat"; id: string } | { kind: "new"; project?: string };

let cached: { hash: string; route: MobileRoute } | null = null;

function parse(hash: string): MobileRoute {
  const path = hash.replace(/^#/, "");
  const chat = /^\/c\/(.+)$/.exec(path);
  if (chat) return { kind: "chat", id: decodeURIComponent(chat[1]) };
  const fresh = /^\/new\/(.+)$/.exec(path);
  if (fresh) return { kind: "new", project: decodeURIComponent(fresh[1]) };
  return { kind: "new" };
}

/** The current route. Stable identity while the hash is unchanged (`useSyncExternalStore`). */
export function readRoute(): MobileRoute {
  const hash = window.location.hash;
  if (cached?.hash !== hash) cached = { hash, route: parse(hash) };
  return cached.route;
}

export function subscribeRoute(listener: () => void): () => void {
  // navigate() uses pushState so the hash itself stays in the URL without the browser
  // emitting hashchange. Back/forward gestures do the opposite: they emit popstate,
  // not hashchange. Listen to both or the page gets stuck on the old chat after Back.
  window.addEventListener("hashchange", listener);
  window.addEventListener("popstate", listener);
  return () => {
    window.removeEventListener("hashchange", listener);
    window.removeEventListener("popstate", listener);
  };
}

function hashFor(route: MobileRoute): string {
  if (route.kind === "chat") return `#/c/${encodeURIComponent(route.id)}`;
  return route.project ? `#/new/${encodeURIComponent(route.project)}` : "#/";
}

/**
 * Go somewhere. `replace` is for a move the user did not make as a step of their own —
 * the new-chat page becoming the chat it created, or leaving a chat that was just
 * deleted — so back does not land on a page that no longer means anything.
 */
export function navigate(route: MobileRoute, options?: { replace?: boolean }): void {
  const hash = hashFor(route);
  if (hash === window.location.hash || (hash === "#/" && !window.location.hash)) return;
  if (options?.replace) window.history.replaceState(null, "", hash);
  else window.history.pushState(null, "", hash);
  // Neither history call fires `hashchange` by itself.
  window.dispatchEvent(new HashChangeEvent("hashchange"));
}
