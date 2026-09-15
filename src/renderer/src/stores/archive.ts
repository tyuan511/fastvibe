import { useMemo } from "react";
import { useSettingsStore } from "@/stores/settings";

/**
 * Archived conversations are a preference, not engine state: the catalog keeps
 * the transcript, this list only decides whether the chat shows up in the
 * sidebar. It lives in `settings.json` (see `stores/settings.ts`) so the same
 * list is visible from the sidebar and from Settings → 归档对话.
 */
const LEGACY_KEY = "fastvibe.sidebar.archived";
const EMPTY: string[] = [];

/** Ids of every archived conversation, as a Set for the sidebar's filters. */
export function useArchivedIds(): Set<string> {
  const ids = useSettingsStore((state) => state.settings.archivedConversations);
  return useMemo(() => new Set(ids ?? EMPTY), [ids]);
}

/** Every archived conversation id, in archive order. */
export function archivedIdList(): string[] {
  return useSettingsStore.getState().settings.archivedConversations ?? EMPTY;
}

function write(ids: string[]): void {
  useSettingsStore.getState().update({ archivedConversations: ids });
}

/** Hide conversations from the sidebar. Already-archived ids are left untouched. */
export function archiveConversations(ids: string | string[]): void {
  const adding = typeof ids === "string" ? [ids] : ids;
  const current = archivedIdList();
  const next = [...current];
  for (const id of adding) if (!next.includes(id)) next.push(id);
  if (next.length !== current.length) write(next);
}

/**
 * Drop ids from the archived list. Used both by "恢复" (the conversation returns
 * to the sidebar) and after a delete (the conversation no longer exists).
 */
export function restoreConversations(ids: string | string[]): void {
  const removing = new Set(typeof ids === "string" ? [ids] : ids);
  const current = archivedIdList();
  const next = current.filter((id) => !removing.has(id));
  if (next.length !== current.length) write(next);
}

// Builds before the settings store owned this list kept it in localStorage;
// promote it once so archives survive the switch to `settings.json`.
if (typeof window !== "undefined") {
  const store = useSettingsStore.getState();
  if (!Array.isArray(store.settings.archivedConversations)) {
    let legacy: string[] = [];
    try {
      const parsed = JSON.parse(localStorage.getItem(LEGACY_KEY) ?? "[]") as unknown;
      if (Array.isArray(parsed)) legacy = parsed.filter((item): item is string => typeof item === "string");
    } catch {
      legacy = [];
    }
    store.update({ archivedConversations: legacy });
    try {
      localStorage.removeItem(LEGACY_KEY);
    } catch {
      // ignore private-mode errors
    }
  }
}
