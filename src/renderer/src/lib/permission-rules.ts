import { useMemo } from "react";
import { useSettingsStore } from "@/stores/settings";
import type { PermissionRequest } from "@shared/types";

/**
 * 始终允许 rules — the approvals the user does not want to be asked about again.
 *
 * A permission decision is a preference about *this machine*, not about the chat it
 * was made in: the same `bash` pattern reaches the sandbox from every conversation,
 * and answering 「始终允许」 in one of them and then being asked again in the next is
 * the same rule twice. It used to be a field on the session store, which meant it was
 * scoped to the window's lifetime and lost on restart — 「始终允许」 that forgets is
 * worse than not offering it, because the user has stopped expecting the prompt.
 *
 * Kept in `settings.json` with the other preferences (see `stores/settings.ts`), so it
 * is shared by every window and survives a reload.
 */

const EMPTY: string[] = [];

/**
 * Identity of a rule: the prompt's method, title and message.
 *
 * Deliberately not the conversation or the prompt id — those differ per occurrence,
 * which is exactly what a remembered rule has to ignore. Two different commands have
 * different messages (`运行命令：npm test` vs `运行命令：rm -rf …`), so the rule is a
 * real pattern rather than a blanket approval.
 */
export function permissionKey(request: PermissionRequest): string {
  return `${request.method}:${request.title ?? ""}:${request.message ?? ""}`;
}

export function usePermissionAlways(): string[] {
  const keys = useSettingsStore((state) => state.settings.permissionAlways);
  return useMemo(() => keys ?? EMPTY, [keys]);
}

export function permissionAlwaysKeys(): string[] {
  return useSettingsStore.getState().settings.permissionAlways ?? EMPTY;
}

/** Remember a rule. Already-remembered keys are left alone, so the list stays a set. */
export function rememberPermission(key: string): void {
  const current = permissionAlwaysKeys();
  if (current.includes(key)) return;
  useSettingsStore.getState().update({ permissionAlways: [...current, key] });
}

/** Forget every rule — 设置 → 通用 offers this so a remembered approval can be revoked. */
export function clearRememberedPermissions(): void {
  useSettingsStore.getState().update({ permissionAlways: [] });
}
