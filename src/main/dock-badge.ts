import { Ipc } from "../shared/ipc.ts";
import type { WorkspaceSnapshot } from "../shared/types.ts";
import { observe } from "./ipc/broadcast.ts";

/**
 * Follow the same merged catalog the sidebar receives, including bound remote projects.
 * Count unread conversations, not completion events: reads, deletes and restarts then
 * need no separate counter to reconcile. The native Dock setter is supplied after ready.
 */
export function watchUnreadBadge(initial: WorkspaceSnapshot, setBadge: (text: string) => void): () => void {
  let previous: string | undefined;
  const update = (snapshot: WorkspaceSnapshot): void => {
    const unread = new Set(snapshot.conversations
      .filter((conversation) => conversation.kind !== "side-chat" && conversation.unread === true)
      .map((conversation) => conversation.id));
    const text = unread.size > 0 ? String(unread.size) : "";
    if (text === previous) return;
    setBadge(text);
    previous = text;
  };

  update(initial);
  return observe(({ channel, payload }) => {
    if (channel === Ipc.workspaceChanged) update(payload as WorkspaceSnapshot);
  });
}
