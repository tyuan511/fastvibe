import { useSettingsStore } from "@/stores/settings";

/** A removed project's sidebar fold / 展开显示 state goes with it. */
export function forgetSidebarProject(cwd: string): void {
  const store = useSettingsStore.getState();
  const { sidebarCollapsedProjects: folded, sidebarExpandedProjects: expanded } = store.settings;
  if (!folded?.includes(cwd) && !expanded?.includes(cwd)) return;
  store.update({
    ...(folded ? { sidebarCollapsedProjects: folded.filter((item) => item !== cwd) } : {}),
    ...(expanded ? { sidebarExpandedProjects: expanded.filter((item) => item !== cwd) } : {}),
  });
}
