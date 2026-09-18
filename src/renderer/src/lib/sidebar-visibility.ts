import { useEffect, useState } from "react";
import { create } from "zustand";
import { useSettingsStore } from "@/stores/settings";

/**
 * Whether the conversation sidebar is showing, and how hiding it behaves.
 *
 * On a desktop-width layout the sidebar is a column that pushes the chat aside, and
 * whether it is collapsed is a preference worth remembering — `settings.json`, shared by
 * every window.
 *
 * On a phone there is no room to push anything: the sidebar's minimum width alone is most
 * of a 375pt screen, so it overlays as a drawer instead. Its open/closed state is
 * deliberately *not* the persisted preference, because that file is one setting shared by
 * every client of this machine — swiping the drawer open on a phone would otherwise
 * collapse the sidebar on the desktop the phone is connected to, and closing it would pop
 * it back. Per-device state belongs to the device.
 */

/** Below this the sidebar overlays instead of pushing. Tailwind's `md` breakpoint. */
const NARROW_QUERY = "(max-width: 767px)";

export function isNarrowViewport(): boolean {
  return typeof window !== "undefined" && window.matchMedia(NARROW_QUERY).matches;
}

/** Re-renders on rotation and on a desktop window being dragged narrow. */
export function useIsNarrowViewport(): boolean {
  const [narrow, setNarrow] = useState(isNarrowViewport);
  useEffect(() => {
    const query = window.matchMedia(NARROW_QUERY);
    const sync = (): void => setNarrow(query.matches);
    sync();
    query.addEventListener("change", sync);
    return () => query.removeEventListener("change", sync);
  }, []);
  return narrow;
}

type DrawerState = {
  /** Narrow layouts only. Always starts closed, so a phone opens on the conversation. */
  open: boolean;
  setOpen: (open: boolean) => void;
};

const useDrawerStore = create<DrawerState>((set) => ({
  open: false,
  setOpen: (open) => set({ open }),
}));

/** Whether the sidebar is hidden right now, by whichever rule applies to this layout. */
export function useSidebarCollapsed(): boolean {
  const narrow = useIsNarrowViewport();
  const drawerOpen = useDrawerStore((state) => state.open);
  const persisted = useSettingsStore((state) => state.settings.sidebarCollapsed ?? false);
  return narrow ? !drawerOpen : persisted;
}

/** Show or hide it: remembered on a desktop layout, local to this device on a phone. */
export function setSidebarCollapsed(collapsed: boolean): void {
  if (isNarrowViewport()) useDrawerStore.getState().setOpen(!collapsed);
  else useSettingsStore.getState().update({ sidebarCollapsed: collapsed });
}
