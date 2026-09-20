import { join } from "node:path";
import { app, BrowserWindow, screen } from "electron";
import { computerPermissions } from "./cua-bridge";

/**
 * The floating panel the user drags into System Settings › Privacy & Security.
 *
 * macOS will not let an application grant itself Accessibility or Screen Recording; the
 * user has to add it to a list in another application's window. A drag source inside
 * FastVibe's own Settings cannot serve that, because the moment System Settings comes
 * forward the source is behind it — the gesture needs both windows visible at once, and
 * only one of them is under this app's control.
 *
 * So the source becomes its own window: chrome-less, always on top, and drawn to look
 * like the row the drop is going to create. It floats over System Settings, the user
 * drags it into the list, and the row that appears is the one they were already holding.
 *
 * The panel closes itself the moment the permission it asked for is granted, so the
 * gesture is never left on screen after it has stopped meaning anything.
 */

let overlay: BrowserWindow | null = null;
let poll: NodeJS.Timeout | undefined;

/** Sized to the panel's markup: a 14px grip over a 56px row, with 8px of shadow room. */
const WIDTH = 300;
const HEIGHT = 86;

export type GrantPermission = "accessibility" | "screenRecording";

export function showGrantOverlay(permission: GrantPermission): void {
  if (process.platform !== "darwin") return;
  if (overlay && !overlay.isDestroyed()) {
    void loadPanel(overlay, permission);
    overlay.showInactive();
    return;
  }

  overlay = new BrowserWindow({
    width: WIDTH,
    height: HEIGHT,
    ...initialPosition(),
    frame: false,
    transparent: true,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    // Out of the window cycle and the Dock's window menu: this is a transient
    // instrument, not a document the user should be able to tab back to later.
    skipTaskbar: true,
    hasShadow: false,
    show: false,
    webPreferences: {
      preload: join(__dirname, "../preload/index.mjs"),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // "floating" clears ordinary windows, System Settings among them, without the
  // screen-saver level's habit of covering menus and system alerts too.
  overlay.setAlwaysOnTop(true, "floating");
  overlay.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  overlay.on("closed", () => {
    overlay = null;
    stopPolling();
  });

  void loadPanel(overlay, permission).then(() => {
    // `showInactive`, not `show`: taking focus would pull the user out of System
    // Settings, which is the window they need to be working in.
    overlay?.showInactive();
  });
  startPolling();
}

export function closeGrantOverlay(): void {
  stopPolling();
  if (overlay && !overlay.isDestroyed()) overlay.close();
  overlay = null;
}

export function grantOverlayOpen(): boolean {
  return overlay !== null && !overlay.isDestroyed();
}

async function loadPanel(window: BrowserWindow, permission: GrantPermission): Promise<void> {
  const file = app.isPackaged
    ? join(process.resourcesPath, "grant-overlay", "index.html")
    : join(__dirname, "../../resources/grant-overlay/index.html");
  const lang = process.env.FASTVIBE_UI_LANGUAGE === "en" ? "en" : "zh";
  await window.loadFile(file, { query: { permission, lang } });
}

/**
 * Where the panel opens.
 *
 * Top-centre of the display holding the cursor: System Settings opens centred, so the
 * list the panel has to be dragged into is below this, and a panel that starts on top of
 * its own target is one the user has to move before they can use it.
 */
function initialPosition(): { x: number; y: number } {
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const { x, y, width } = display.workArea;
  return { x: Math.round(x + width / 2 - WIDTH / 2), y: y + 24 };
}

/**
 * Close on success.
 *
 * There is no event for "the user flipped a toggle in another application", so the
 * grant is polled. Two seconds is slow enough to be invisible in a profile and fast
 * enough that the panel disappears while the user is still looking at the list.
 */
function startPolling(): void {
  stopPolling();
  poll = setInterval(() => {
    void computerPermissions().then((status) => {
      if (status.ready) closeGrantOverlay();
    });
  }, 2_000);
}

function stopPolling(): void {
  if (poll) clearInterval(poll);
  poll = undefined;
}
