/**
 * Workspace URLs. HashRouter keeps these after the `#`, so a reload of
 * `#/c/<id>` or `#/settings/providers` still lands in the renderer.
 *
 * - `/` — shell with no conversation in the URL (first paint, empty window)
 * - `/c/:id` — a conversation; switching chats pushes a real history entry
 * - `/settings/<section>` — settings overlay; section switches replace
 */

export function conversationPath(id: string): string {
  return `/c/${encodeURIComponent(id)}`;
}

export function workspacePath(id: string | null | undefined): string {
  return id ? conversationPath(id) : "/";
}

export function conversationIdFromPath(pathname: string): string | undefined {
  const match = pathname.match(/^\/c\/([^/]+)\/?$/);
  if (!match?.[1]) return undefined;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1];
  }
}

/** Read the conversation id from the current hash, for the first-paint restore. */
export function conversationIdFromHash(hash = window.location.hash): string | undefined {
  const raw = hash.replace(/^#/, "") || "/";
  const path = (raw.startsWith("/") ? raw : `/${raw}`).split("?")[0] ?? "/";
  return conversationIdFromPath(path);
}
