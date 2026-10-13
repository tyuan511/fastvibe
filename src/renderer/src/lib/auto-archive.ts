import { readAutoArchiveDays, runningIds, staleConversationIds } from "@shared/auto-archive";
import { readPinned } from "@/lib/pinned";
import { archiveConversations, archivedIdList } from "@/stores/archive";
import { useSessionStore } from "@/stores/session";
import { useSettingsStore } from "@/stores/settings";

/**
 * How often a running app checks for conversations that have gone stale. The check is
 * cheap and the first one runs as soon as the workspace loads, so an hour only covers
 * the case of an app left open across the threshold.
 */
export const AUTO_ARCHIVE_SWEEP_MS = 60 * 60 * 1000;

/**
 * Archive every conversation 设置 → 归档对话 says is stale, and report which ids moved.
 *
 * Reads the live stores rather than taking arguments: the sweep is driven by a timer in
 * the shell, and a value captured when the effect ran would decide on a conversation
 * list the app may have moved past. Returns the ids it archived so the caller can offer
 * one 撤销, exactly as the manual archive does.
 */
export function sweepAutoArchive(now: number = Date.now()): string[] {
  const days = readAutoArchiveDays(useSettingsStore.getState().settings.autoArchiveDays);
  if (days <= 0) return [];
  const session = useSessionStore.getState();
  const ids = staleConversationIds(session.conversations, {
    now,
    days,
    archived: new Set(archivedIdList()),
    pinned: new Set(Object.keys(readPinned())),
    running: runningIds(session.running),
    activeId: session.activeId,
  });
  if (ids.length > 0) archiveConversations(ids);
  return ids;
}
