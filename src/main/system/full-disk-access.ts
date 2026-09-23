import { app, shell } from "electron";
import type { FullDiskAccessStatus } from "@shared/ipc";
import { appBundlePath, fullDiskAccessSettingsUrl, hasFullDiskAccess } from "../engine/full-disk-access";

/**
 * The desktop half of the grant.
 *
 * macOS will not show an Allow / Don't Allow dialog for Full Disk Access — the user
 * has to flip a switch in System Settings — and an application that has never touched
 * a protected file does not appear in that list. The probe is what registers the row;
 * opening the pane is what puts the switch in front of the user. Neither call can
 * grant anything by itself.
 */
export function fullDiskAccessStatus(): FullDiskAccessStatus {
  return {
    applicable: process.platform === "darwin",
    granted: hasFullDiskAccess(),
    packaged: app.isPackaged,
  };
}

export async function openFullDiskAccessSettings(): Promise<void> {
  if (process.platform !== "darwin") return;
  // Probe before the pane opens, so the row exists by the time the list is on screen.
  hasFullDiskAccess();
  await shell.openExternal(fullDiskAccessSettingsUrl()).catch(() => undefined);
}

export function revealFullDiskApp(): void {
  if (process.platform !== "darwin") return;
  shell.showItemInFolder(appBundlePath(app.getPath("exe")));
}
