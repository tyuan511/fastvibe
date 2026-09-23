/**
 * The phone page's three places, kept in the hash so the system back gesture (Android's
 * back button, iOS's edge swipe in a home-screen app) walks them like any other page.
 *
 * - `#/`              the conversation list
 * - `#/c/<id>`        one conversation
 * - `#/new[/<cwd>]`   a new conversation, optionally in a project
 */
export type MobileRoute =
  | { kind: "list" }
  | { kind: "chat"; id: string }
  | { kind: "new"; project?: string };

let cached: { hash: string; route: MobileRoute } | null = null;

function parse(hash: string): MobileRoute {
  const path = hash.replace(/^#/, "");
  const chat = /^\/c\/(.+)$/.exec(path);
  if (chat) return { kind: "chat", id: decodeURIComponent(chat[1]) };
  const fresh = /^\/new(?:\/(.+))?$/.exec(path);
  if (fresh) return { kind: "new", project: fresh[1] ? decodeURIComponent(fresh[1]) : undefined };
  return { kind: "list" };
}

/** The current route. Stable identity while the hash is unchanged (`useSyncExternalStore`). */
export function readRoute(): MobileRoute {
  const hash = window.location.hash;
  if (cached?.hash !== hash) cached = { hash, route: parse(hash) };
  return cached.route;
}

export function subscribeRoute(listener: () => void): () => void {
  window.addEventListener("hashchange", listener);
  return () => window.removeEventListener("hashchange", listener);
}

function hashFor(route: MobileRoute): string {
  if (route.kind === "chat") return `#/c/${encodeURIComponent(route.id)}`;
  if (route.kind === "new") return route.project ? `#/new/${encodeURIComponent(route.project)}` : "#/new";
  return "#/";
}

/**
 * Go somewhere. `replace` is for a move the user did not make as a step of their own —
 * the new-chat page becoming the chat it created — so back skips the empty page.
 */
export function navigate(route: MobileRoute, options?: { replace?: boolean }): void {
  const hash = hashFor(route);
  if (options?.replace) {
    window.history.replaceState(null, "", hash);
    window.dispatchEvent(new HashChangeEvent("hashchange"));
    return;
  }
  window.location.hash = hash;
}

/**
 * Back to the list. A real history step when the list is what came before (so the
 * gesture and the button agree), a replace when the page was opened on a chat directly
 * — a link from a notification or the QR code — where history has nothing to go back to.
 */
export function backToList(): void {
  if (window.history.length > 1 && window.history.state?.fromList === true) {
    window.history.back();
    return;
  }
  navigate({ kind: "list" }, { replace: true });
}

/** Open a chat from the list, marking the entry so `backToList` knows it can go back. */
export function openFromList(route: MobileRoute): void {
  window.history.pushState({ fromList: true }, "", hashFor(route));
  window.dispatchEvent(new HashChangeEvent("hashchange"));
}
