import { useSettingsStore } from "@/stores/settings";

/**
 * The 文件 tab's expanded directories, per project cwd, kept in settings.json so a
 * project's tree reopens as it was left — after a chat switch, a pane remount or a
 * restart. A tree with nothing expanded stores nothing.
 */
export function readExpandedDirs(cwd: string): Set<string> {
  return new Set(useSettingsStore.getState().settings.fileTreeExpanded?.[cwd] ?? []);
}

export function writeExpandedDirs(cwd: string, expanded: Set<string>): void {
  const store = useSettingsStore.getState();
  const current = store.settings.fileTreeExpanded ?? {};
  const previous = current[cwd] ?? [];
  if (previous.length === expanded.size && previous.every((dir) => expanded.has(dir))) return;
  const next = { ...current };
  if (expanded.size === 0) delete next[cwd];
  else next[cwd] = [...expanded].sort();
  store.update({ fileTreeExpanded: next });
}

/** A removed project's tree state goes with it. */
export function forgetFileTree(cwd: string): void {
  const current = useSettingsStore.getState().settings.fileTreeExpanded;
  if (!current || !(cwd in current)) return;
  const { [cwd]: _gone, ...rest } = current;
  useSettingsStore.getState().update({ fileTreeExpanded: rest });
}
