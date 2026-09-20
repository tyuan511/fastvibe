import { join } from "node:path";
import { app, BrowserWindow, screen, shell } from "electron";
import { Ipc } from "@shared/ipc";
import type { GrantFlowState, GrantPermission } from "@shared/types";
import { broadcast } from "../ipc/broadcast";
import { computerPermissions, requestComputerPermissions } from "./cua-bridge";

/**
 * The guided macOS grant flow: one click, then one permission at a time.
 *
 * macOS will not let an application grant itself Accessibility or Screen Recording; the
 * user has to add it to a list in another application's window. Two things follow, and
 * together they decide the shape of this module.
 *
 * A drag source inside FastVibe's own Settings cannot serve that gesture, because the
 * moment System Settings comes forward the source is behind it. So the source is its own
 * chrome-less always-on-top window, drawn to look like the row the drop is going to
 * create — the user drags it in, and the row that appears is the one they were holding.
 *
 * And asking the user to work out which pane to open, in what order, twice, is asking
 * them to do the part the app knows. So this is a queue rather than a button: each step
 * opens the pane its permission lives in, re-labels the panel for it, and waits. When
 * macOS reports the grant, the next step opens itself. The user presses 授权 once and
 * drags twice.
 *
 * Screen Recording goes first deliberately. macOS commonly wants an application
 * restarted before a new Screen Recording grant takes effect, and taking that step first
 * means the restart lands before the rest of the flow rather than in the middle of it.
 */

let overlay: BrowserWindow | null = null;
let timer: NodeJS.Timeout | undefined;
/** Steps still to do. The head is the step the panel is currently showing. */
let queue: GrantPermission[] = [];
let total = 0;

/** Sized to the panel's markup: a 14px grip over a 56px row, with 8px of shadow room. */
const WIDTH = 300;
const HEIGHT = 86;

/** Screen Recording first; see the restart note above. */
const ORDER: readonly GrantPermission[] = ["screenRecording", "accessibility"];

/** The Privacy & Security anchors each permission's list lives behind. */
const PANE: Record<GrantPermission, string> = {
  screenRecording: "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
  accessibility: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
};

export function grantFlowState(): GrantFlowState {
  const permission = queue[0];
  if (!permission) return { active: false, step: 0, total: 0 };
  return { active: true, permission, step: total - queue.length + 1, total };
}

function publish(): void {
  broadcast(Ipc.computerGrantFlowState, grantFlowState());
}

/**
 * Begin, or restart, the sequence.
 *
 * The request comes first and unconditionally: it is what *registers* FastVibe in
 * Privacy & Security, and an application that has never asked does not appear in those
 * lists at all — so without it the panel would be dragged towards a list that has no
 * row to accept it.
 */
export async function startGrantFlow(): Promise<GrantFlowState> {
  if (process.platform !== "darwin") return grantFlowState();
  const status = await requestComputerPermissions();
  queue = ORDER.filter((permission) => !status[permission]);
  total = queue.length;
  if (queue.length === 0) {
    closeOverlay();
    publish();
    return grantFlowState();
  }
  await advance();
  startPolling();
  publish();
  return grantFlowState();
}

export function cancelGrantFlow(): void {
  queue = [];
  total = 0;
  stopPolling();
  closeOverlay();
  publish();
}

/** Open the current step's pane and point the panel at it. */
async function advance(): Promise<void> {
  const permission = queue[0];
  if (!permission) return;
  // Best-effort: a macOS build that renamed the anchor should cost the user a manual
  // trip to System Settings, not the rest of the flow.
  await shell.openExternal(PANE[permission]).catch(() => undefined);
  await showOverlay(permission);
}

async function showOverlay(permission: GrantPermission): Promise<void> {
  const state = grantFlowState();
  if (overlay && !overlay.isDestroyed()) {
    // Re-label in place rather than reloading: a 300×86 panel that blinks between
    // steps reads as a glitch, and the flow is meant to feel like one object moving on.
    await overlay.webContents
      .executeJavaScript(`window.__setStep(${JSON.stringify({ permission, step: state.step, total: state.total })})`)
      .catch(() => undefined);
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
    // Out of the window cycle and the Dock's window menu: a transient instrument, not a
    // document the user should be able to tab back to later.
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
  });

  const file = app.isPackaged
    ? join(process.resourcesPath, "grant-overlay", "index.html")
    : join(__dirname, "../../resources/grant-overlay/index.html");
  await overlay.loadFile(file, {
    query: {
      permission,
      lang: process.env.FASTVIBE_UI_LANGUAGE === "en" ? "en" : "zh",
      step: String(state.step),
      total: String(state.total),
    },
  });
  // `showInactive`, not `show`: taking focus would pull the user out of System
  // Settings, which is the window they need to be working in.
  overlay?.showInactive();
}

function closeOverlay(): void {
  if (overlay && !overlay.isDestroyed()) overlay.close();
  overlay = null;
}

/**
 * Advance on success.
 *
 * There is no event for "the user flipped a toggle in another application", so the
 * grants are polled. A second and a half is fast enough that the next pane opens while
 * the user's hand is still on the trackpad, and slow enough to be invisible in a profile.
 */
function startPolling(): void {
  stopPolling();
  timer = setInterval(() => {
    void tick();
  }, 1_500);
}

async function tick(): Promise<void> {
  const permission = queue[0];
  if (!permission) return;
  const status = await computerPermissions();
  if (!status[permission]) return;
  queue = queue.slice(1);
  if (queue.length === 0) {
    stopPolling();
    closeOverlay();
    total = 0;
    publish();
    return;
  }
  await advance();
  publish();
}

function stopPolling(): void {
  if (timer) clearInterval(timer);
  timer = undefined;
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
