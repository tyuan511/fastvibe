import { app, BrowserWindow, nativeImage, screen, shell } from "electron";
import { join } from "node:path";
import { Ipc } from "@shared/ipc";
import { windowBackgroundColor } from "./engine/app-settings";
import { getFastVibePaths } from "./engine/paths";
import { log } from "./engine/logger";
import { readWindowState, writeWindowState } from "./engine/window-state";
import { attachBrowserRenderer } from "./pi/browser-bridge";

let mainWindow: BrowserWindow | null = null;

function resolveAppIcon(): string {
  const name = process.platform === "darwin" ? "icon.icns" : "icon.png";
  return app.isPackaged
    ? join(process.resourcesPath, name)
    : join(__dirname, "../../resources", name);
}

export function applyAppIcon(): void {
  const image = nativeImage.createFromPath(resolveAppIcon());
  if (image.isEmpty()) return;
  if (process.platform === "darwin") {
    app.dock?.setIcon(image);
  }
}

/**
 * macOS keeps its own traffic lights, inset into the app's first row
 * (`hiddenInset`). Windows and Linux have no such thing to inset, so the window
 * ships with no chrome at all and the renderer draws the whole title bar — logo,
 * history and its own minimise/maximise/close (`components/layout/title-bar.tsx`).
 */
const IS_MAC = process.platform === "darwin";
const DEFAULT_WINDOW_SIZE = { width: 1280, height: 840 } as const;
const MIN_WINDOW_SIZE = { width: 920, height: 640 } as const;
const WINDOW_STATE_SAVE_DELAY_MS = 250;

export function createDesktopWindow(windows: Set<BrowserWindow>): void {
  const paths = getFastVibePaths();
  const restored = readWindowState(paths.windowStateFile);
  const workArea = screen.getPrimaryDisplay().workAreaSize;
  const width = clampWindowDimension(restored?.width ?? DEFAULT_WINDOW_SIZE.width, MIN_WINDOW_SIZE.width, workArea.width);
  const height = clampWindowDimension(restored?.height ?? DEFAULT_WINDOW_SIZE.height, MIN_WINDOW_SIZE.height, workArea.height);
  const window = new BrowserWindow({
    width,
    height,
    minWidth: MIN_WINDOW_SIZE.width,
    minHeight: MIN_WINDOW_SIZE.height,
    title: "FastVibe",
    icon: resolveAppIcon(),
    backgroundColor: windowBackgroundColor(),
    // A frameless Linux window is the predictable spelling of the same thing
    // across window managers; on Windows `hidden` keeps the native thick frame,
    // so the window still resizes, snaps and casts a shadow.
    frame: process.platform === "linux" ? false : undefined,
    titleBarStyle: IS_MAC ? "hiddenInset" : "hidden",
    trafficLightPosition: IS_MAC ? { x: 16, y: 16 } : undefined,
    show: false,
      webPreferences: {
        preload: join(__dirname, "../preload/index.mjs"),
        sandbox: false,
        contextIsolation: true,
        nodeIntegration: false,
        webviewTag: true,
      },
  });

  let stateSaveTimer: ReturnType<typeof setTimeout> | undefined;
  const persistWindowState = (): void => {
    if (window.isDestroyed()) return;
    const bounds = window.getNormalBounds();
    try {
      writeWindowState(paths.windowStateFile, {
        width: bounds.width,
        height: bounds.height,
        maximized: window.isMaximized(),
      });
    } catch (error) {
      log.warn(`window state save failed: ${String(error)}`);
    }
  };
  const scheduleWindowStateSave = (): void => {
    if (stateSaveTimer) clearTimeout(stateSaveTimer);
    stateSaveTimer = setTimeout(() => {
      stateSaveTimer = undefined;
      persistWindowState();
    }, WINDOW_STATE_SAVE_DELAY_MS);
  };

  window.on("ready-to-show", () => {
    if (restored?.maximized) window.maximize();
    window.show();
  });
  window.on("resize", scheduleWindowStateSave);
  window.on("close", () => {
    if (stateSaveTimer) clearTimeout(stateSaveTimer);
    stateSaveTimer = undefined;
    persistWindowState();
  });
  // The title bar's maximise control swaps its glyph on this; Main owns the truth
  // because the OS can also maximise the window (snap, double-click, a WM key).
  const sendWindowState = (): void => {
    if (window.isDestroyed()) return;
    window.webContents.send(Ipc.windowState, { maximized: window.isMaximized() });
  };
  const handleMaximizedStateChange = (): void => {
    sendWindowState();
    scheduleWindowStateSave();
  };
  window.on("maximize", handleMaximizedStateChange);
  window.on("unmaximize", handleMaximizedStateChange);
  // Window events are subscribed through its App Protocol session in the transport, so
  // there is no per-window `subscribe({...})` here — the hub does not know what a
  // window is, and the transport's session is what hands it pushes.
  window.on("closed", () => {
    if (stateSaveTimer) clearTimeout(stateSaveTimer);
    windows.delete(window);
    if (mainWindow === window) mainWindow = windows.values().next().value ?? null;
  });
  window.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url);
    return { action: "deny" };
  });
  window.webContents.on("preload-error", (path, error) => {
    log.error(`preload-error path=${path}`, error);
  });
  window.webContents.on("unresponsive", () => log.warn("window unresponsive"));
  window.webContents.on("responsive", () => log.info("window responsive"));
  attachBrowserRenderer(window.webContents);

  if (process.env.ELECTRON_RENDERER_URL) {
    window.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    window.loadFile(join(__dirname, "../renderer/index.html"));
  }

  mainWindow = window;
  windows.add(window);
  log.info("window opened");
}

function clampWindowDimension(value: number, minimum: number, available: number): number {
  return Math.min(Math.max(value, minimum), Math.max(minimum, available));
}

/**
 * Broadcast identity of one window, derived from its WebContents id. It is what
 * `settings:set` skips so a window is not told to re-read what it just wrote.
 */
export function windowOrigin(webContentsId: number): string {
  return `window:${webContentsId}`;
}
