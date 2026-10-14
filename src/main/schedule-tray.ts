import { app, Menu, nativeImage, Tray } from "electron";
import { join } from "node:path";
import { uiText } from "./engine/ui-text";

let tray: Tray | null = null;

/** Closing the last window is not Quit when schedules are enabled. Keep a visible
 * way back to the UI (and an explicit exit) on Windows/Linux as well as macOS. */
export function syncScheduleTray(enabled: boolean, open: () => void, quit: () => void): void {
  if (!enabled) { tray?.destroy(); tray = null; return; }
  if (!tray) {
    const icon = nativeImage.createFromPath(app.isPackaged
      ? join(process.resourcesPath, "icon.png")
      : join(__dirname, "../../resources/icon.png"));
    tray = new Tray(icon.resize({ width: 18, height: 18 }));
    tray.setToolTip("FastVibe");
    tray.on("double-click", open);
  }
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: uiText("打开 FastVibe", "Open FastVibe"), click: open },
    { label: uiText("退出 FastVibe", "Quit FastVibe"), click: quit },
  ]));
}

export function disposeScheduleTray(): void { tray?.destroy(); tray = null; }
