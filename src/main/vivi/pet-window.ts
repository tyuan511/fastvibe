import { BrowserWindow, Menu, screen } from "electron";
import { join } from "node:path";
import { Ipc } from "@shared/ipc";
import type { ViviActor, ViviDragMotion, ViviImpact, ViviMood, ViviSettings, ViviSnapshot, ViviState } from "../../shared/vivi";
import { normalizeViviSettings } from "../../shared/vivi";
import { readAppSettings } from "../engine/app-settings";
import { getFastVibePaths } from "../engine/paths";
import { log } from "../engine/logger";
import { uiText } from "../engine/ui-text";
import { broadcast } from "../ipc/broadcast";
import { ViviStateStore } from "./state";
import { clampViviBounds, viviBoundsFor, VIVI_BASE_SIZE } from "./bounds";
import { ViviFlight, ViviThrowVelocity } from "./throw-motion";
import { viviNotificationSurfaceLayout } from "./panel-bounds";
import type { ViviBubbleKind, ViviSurfaceLayout } from "../../shared/vivi";

type PersistSettings = (settings: ViviSettings) => void;
const SUCCESS_DURATION_MS = 5_000;

export class ViviPetWindow {
  private window: BrowserWindow | null = null;
  private notificationWindow: BrowserWindow | null = null;
  private notificationReady = false;
  private moving = false;
  private lastMotionAt = -Infinity;
  private mainWindow: BrowserWindow | null = null;
  private desktopBounds: Electron.Rectangle | undefined;
  private readonly onFullScreenChanged = (): void => this.syncFullScreenParent();
  private readonly onMainWindowClose = (): void => this.setMainWindow(null);
  private store = new ViviStateStore(readAppSettings(getFastVibePaths()));
  private persistSettings: PersistSettings | undefined;
  private dragTimer: ReturnType<typeof setInterval> | undefined;
  private dragOrigin: { cursorX: number; cursorY: number; windowX: number; windowY: number } | undefined;
  private throwVelocity = new ViviThrowVelocity();
  private flight: ViviFlight | undefined;
  private flightTimer: ReturnType<typeof setInterval> | undefined;
  private flightAt = 0;
  private mouseHeld = false;
  private dragAt = 0;
  private lastImpactAt = -Infinity;
  private error: string | undefined;
  private disposed = false;
  private modelReady = false;
  private appFocused = false;
  private showRequested = false;
  private successTimer: ReturnType<typeof setTimeout> | undefined;
  private bubbleHeight = 0;
  private bubbleKind: ViviBubbleKind = "notification";
  private composerHeight = 0;
  private bubbleWidth: number | undefined;
  private surface: ViviSurfaceLayout | undefined;
  private updatingSurface = false;
  private readonly onDisplaysChanged = (): void => {
    this.cancelMotion();
    if (!this.window || this.window.isDestroyed()) return;
    const settings = this.getSettings();
    this.setWindowBounds(this.boundsFor(settings, screen.getDisplayMatching(this.petBounds())));
    if (settings.position === "custom") this.savePosition();
  };

  setPersistence(callback: PersistSettings): void { this.persistSettings = callback; }

  create(): void {
    if (this.window || this.disposed) return;
    const settings = this.getSettings();
    this.showRequested = settings.enabled;
    this.modelReady = false;
    const size = Math.round(VIVI_BASE_SIZE * settings.scale);
    const display = settings.position === "custom" && settings.x !== undefined && settings.y !== undefined
      ? screen.getDisplayMatching({ x: settings.x, y: settings.y, width: size, height: size })
      : screen.getPrimaryDisplay();
    const window = new BrowserWindow({
      ...viviBoundsFor(settings, display.workArea),
      title: "Vivi",
      frame: false,
      transparent: true,
      backgroundColor: "#00000000",
      hasShadow: false,
      resizable: false,
      fullscreenable: false,
      maximizable: false,
      minimizable: false,
      movable: true,
      focusable: true,
      skipTaskbar: true,
      alwaysOnTop: settings.alwaysOnTop,
      show: false,
      webPreferences: {
        preload: join(__dirname, "../preload/index.mjs"),
        sandbox: false,
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    this.window = window;
    window.setIgnoreMouseEvents(true, { forward: true });
    this.surface = undefined;
    this.createNotificationWindow();
    this.syncFullScreenParent();
    this.setWindowBounds(this.petBounds());
    screen.on("display-added", this.onDisplaysChanged);
    screen.on("display-removed", this.onDisplaysChanged);
    screen.on("display-metrics-changed", this.onDisplaysChanged);
    window.on("move", () => { if (!this.updatingSurface && !this.dragOrigin && !this.flight) this.keepOnScreen(); });
    window.on("blur", () => {
      this.mouseHeld = false;
      if (this.dragOrigin) this.stopDrag(false);
      else if (this.moving && !this.flight) this.publishDragMotion(false);
    });
    window.webContents.on("before-mouse-event", (_event, mouse) => {
      if (mouse.type === "mouseDown" && mouse.button === "left") {
        this.mouseHeld = true;
        this.stopFlight();
      } else if ((mouse.type === "mouseUp" && mouse.button === "left")
        || (mouse.type === "mouseMove" && mouse.modifiers !== undefined && !mouse.modifiers.includes("leftbuttondown"))) {
        const wasHeld = this.mouseHeld;
        this.mouseHeld = false;
        if (this.dragOrigin) this.stopDrag();
        else if (wasHeld && this.moving && !this.flight) this.publishDragMotion(false);
      }
    });
    window.on("show", () => { this.store.setVisible(true); this.syncNotificationVisibility(); this.publish(); });
    window.on("hide", () => { this.store.setVisible(false); this.syncNotificationVisibility(); this.publish(); });
    window.on("closed", () => {
      screen.removeListener("display-added", this.onDisplaysChanged);
      screen.removeListener("display-removed", this.onDisplaysChanged);
      screen.removeListener("display-metrics-changed", this.onDisplaysChanged);
      this.cancelMotion();
      this.window = null;
      this.notificationWindow?.destroy();
      this.notificationWindow = null;
      this.notificationReady = false;
      this.modelReady = false;
      this.showRequested = false;
      this.store.setVisible(false);
      this.publish();
    });
    window.webContents.on("did-start-loading", () => {
      this.cancelMotion();
      this.moving = false;
      this.modelReady = false;
      window.hide();
    });
    window.webContents.on("render-process-gone", () => {
      this.cancelMotion();
      this.moving = false;
      this.modelReady = false;
      window.hide();
    });
    window.webContents.once("did-finish-load", () => {
      if (this.disposed || window.isDestroyed()) return;
      this.publish();
    });
    window.webContents.on("preload-error", (_event, path, error) => log.error(`Vivi preload failed ${path}`, error));
    const loaded = process.env.ELECTRON_RENDERER_URL
      ? window.loadURL(new URL("vivi.html", process.env.ELECTRON_RENDERER_URL).href)
      : window.loadFile(join(__dirname, "../renderer/vivi.html"));
    void loaded.catch((error) => {
      this.error = uiText("Vivi 窗口加载失败，请重新启用。", "Vivi could not load. Turn it off and on to retry.");
      log.error(`Failed to load Vivi window: ${String(error)}`);
      this.publish();
    });
  }

  /** A notice must never resize or rebase the pet's native frame. */
  private createNotificationWindow(): void {
    if (this.disposed || !this.window || this.notificationWindow) return;
    this.notificationReady = false;
    this.bubbleHeight = 0;
    this.bubbleWidth = undefined;
    const window = new BrowserWindow({
      ...this.petBounds(), title: "Vivi", frame: false, transparent: true,
      backgroundColor: "#00000000", hasShadow: false, resizable: false,
      fullscreenable: false, maximizable: false, minimizable: false,
      movable: false, focusable: false, skipTaskbar: true,
      alwaysOnTop: this.getSettings().alwaysOnTop, show: false,
      webPreferences: {
        preload: join(__dirname, "../preload/index.mjs"), sandbox: false,
        contextIsolation: true, nodeIntegration: false, backgroundThrottling: false,
      },
    });
    this.notificationWindow = window;
    window.setParentWindow(this.window.getParentWindow());
    window.setIgnoreMouseEvents(true, { forward: true });
    window.webContents.on("did-start-loading", () => { this.notificationReady = false; window.hide(); });
    window.webContents.on("render-process-gone", () => {
      this.notificationReady = false;
      window.destroy();
    });
    window.on("closed", () => {
      if (this.notificationWindow === window) { this.notificationWindow = null; this.notificationReady = false; }
    });
    const loaded = process.env.ELECTRON_RENDERER_URL
      ? window.loadURL(new URL("vivi.html?notification=1", process.env.ELECTRON_RENDERER_URL).href)
      : window.loadFile(join(__dirname, "../renderer/vivi.html"), { query: { notification: "1" } });
    void loaded.catch((error) => log.warn(`Vivi notification failed to load: ${String(error)}`));
  }

  private syncNotificationVisibility(): void {
    const window = this.notificationWindow;
    if (!window || window.isDestroyed()) return;
    const settings = this.getSettings();
    const show = this.notificationReady && this.modelReady && this.store.state().visible
      && settings.enabled && !this.moving && this.bubbleHeight > 0
      && (this.bubbleKind === "feedback" || (settings.messages && !this.appFocused));
    if (show && !window.isVisible()) window.showInactive();
    else if (!show && window.isVisible()) window.hide();
  }

  /** The model renderer acknowledges its own spring settling, not just mouse release. */
  motionSettled(window: BrowserWindow | null, at: number): void {
    if (this.disposed || !window || window !== this.window || !Number.isFinite(at) || at !== this.lastMotionAt
      || this.dragOrigin || this.flight || this.mouseHeld || !this.moving) return;
    this.moving = false;
    if (this.window && !this.window.isDestroyed()) this.setWindowBounds(this.petBounds());
    this.syncNotificationVisibility();
    this.publish();
  }

  /** Keep the desktop pet independent normally, but auxiliary to our own full-screen Space. */
  setMainWindow(window: BrowserWindow | null): void {
    if (this.disposed || process.platform !== "darwin" || this.mainWindow === window) return;
    this.mainWindow?.removeListener("enter-full-screen", this.onFullScreenChanged);
    this.mainWindow?.removeListener("leave-full-screen", this.onFullScreenChanged);
    this.mainWindow?.removeListener("close", this.onMainWindowClose);
    this.mainWindow = window;
    window?.on("enter-full-screen", this.onFullScreenChanged);
    window?.on("leave-full-screen", this.onFullScreenChanged);
    // Detach before native parent teardown, which would otherwise destroy its child too.
    window?.on("close", this.onMainWindowClose);
    this.syncFullScreenParent();
  }

  private fullScreenArea(): Electron.Rectangle | undefined {
    const main = this.mainWindow;
    return main && !main.isDestroyed() && main.isFullScreen() ? main.getContentBounds() : undefined;
  }

  private movementArea(bounds: Electron.Rectangle): Electron.Rectangle {
    return this.fullScreenArea() ?? screen.getDisplayMatching(bounds).workArea;
  }

  private syncFullScreenParent(): void {
    const window = this.window;
    if (!window || window.isDestroyed()) return;
    const parent = this.fullScreenArea() ? this.mainWindow : null;
    if (window.getParentWindow() === parent) return;
    const bounds = this.petBounds();
    const restore = this.desktopBounds;
    if (parent) this.desktopBounds ??= bounds;
    // Stop a drag/flight after preserving the desktop position so its cleanup cannot
    // save coordinates already clamped into the full-screen display.
    this.cancelMotion();
    if (!parent) this.desktopBounds = undefined;
    // fullscreenable:false gives this window FullScreenAuxiliary on macOS. Parenting
    // puts it in FastVibe's Space without exposing it over every other full-screen app.
    this.notificationWindow?.setParentWindow(parent);
    window.setParentWindow(parent);
    const settings = this.getSettings();
    const desktop = restore ? viviBoundsFor({ ...settings, position: "custom", x: restore.x, y: restore.y }, screen.getDisplayMatching(restore).workArea) : bounds;
    this.setWindowBounds(parent ? this.boundsFor(settings, screen.getDisplayMatching(parent.getBounds())) : desktop);
  }

  show(): void {
    if (!this.getSettings().enabled || this.disposed) return;
    this.create();
    this.createNotificationWindow();
    this.keepOnScreen();
    this.showRequested = true;
    if (this.modelReady && this.window && !this.window.isDestroyed()) this.window.showInactive();
  }

  rendererState(window: BrowserWindow | null, ready: boolean, error?: string): void {
    if (this.disposed || !window || window.isDestroyed()) return;
    if (window === this.notificationWindow) {
      this.notificationReady = ready;
      this.syncNotificationVisibility();
      return;
    }
    if (window !== this.window) return;
    this.modelReady = ready;
    this.error = error;
    if (!ready) window.hide();
    else if (this.showRequested && this.getSettings().enabled) window.showInactive();
    this.publish();
  }

  hide(): void {
    this.showRequested = false;
    this.cancelMotion();
    this.moving = false;
    if (this.window && !this.window.isDestroyed()) this.window.hide();
  }

  destroy(): void {
    this.cancelSuccess();
    this.cancelMotion();
    this.setMainWindow(null);
    this.disposed = true;
    this.notificationWindow?.destroy();
    this.notificationWindow = null;
    if (this.window && !this.window.isDestroyed()) this.window.destroy();
    this.window = null;
  }

  setSettings(patch: Partial<ViviSettings>): ViviSettings {
    const previous = this.getSettings();
    const next = this.store.patchSettings(patch);
    this.persistSettings?.(next);
    this.store.applySettings(next);
    this.applyWindowSettings(previous);
    this.publish();
    return this.getSettings();
  }

  reloadSettings(settings: Record<string, unknown>): void {
    const previous = this.getSettings();
    this.store.applySettings(normalizeViviSettings(settings));
    this.applyWindowSettings(previous);
    this.publish();
  }

  resetPosition(): ViviSettings {
    return this.setSettings({ position: "bottom-right", x: undefined, y: undefined });
  }

  getSettings(): ViviSettings { return this.store.settings(); }
  getState(): ViviState {
    const state = this.store.state();
    if (this.window && !this.window.isDestroyed()) {
      const { x, y } = this.petBounds();
      return { ...state, x, y };
    }
    return state;
  }
  setAppFocused(focused: boolean): void {
    if (this.disposed || this.appFocused === focused) return;
    this.appFocused = focused;
    this.syncNotificationVisibility();
    this.publish();
  }

  getSnapshot(): ViviSnapshot {
    const settings = readAppSettings(getFastVibePaths());
    return { ...this.store.snapshot(), moving: this.moving, appFocused: this.appFocused, surface: this.surface, uiLanguage: settings.uiLanguage === "en" ? "en" : "zh", ...(this.error ? { error: this.error } : {}) };
  }

  updateActors(actors: ViviActor[]): void {
    if (actors.some((actor) => actor.mood === "waiting") && this.successTimer) {
      clearTimeout(this.successTimer);
      this.successTimer = undefined;
    }
    this.store.follow(actors, Boolean(this.successTimer));
    this.publish();
  }

  setMood(mood: ViviMood, conversationId?: string): void {
    this.cancelSuccess();
    this.store.setMood(mood, conversationId);
    if (mood === "success" && !this.disposed) {
      this.successTimer = setTimeout(() => {
        this.successTimer = undefined;
        if (this.disposed) return;
        this.store.restoreActivity();
        this.publish();
      }, SUCCESS_DURATION_MS);
    }
    this.publish();
  }

  private cancelSuccess(): void {
    if (this.successTimer) clearTimeout(this.successTimer);
    this.successTimer = undefined;
  }

  startDrag(): void {
    if (!this.window || this.window.isDestroyed() || this.dragTimer || !this.mouseHeld) return;
    this.stopFlight();
    this.keepOnScreen();
    const cursor = screen.getCursorScreenPoint();
    const { x: windowX, y: windowY } = this.petBounds();
    this.dragAt = performance.now();
    this.lastImpactAt = -Infinity;
    this.throwVelocity.begin(cursor, this.dragAt);
    this.dragOrigin = { cursorX: cursor.x, cursorY: cursor.y, windowX, windowY };
    this.publishDragMotion(true);
    this.dragTimer = setInterval(() => this.moveDrag(), 16);
  }

  stopDrag(throwPet = true): void {
    if (!this.dragOrigin) return;
    if (this.dragTimer) clearInterval(this.dragTimer);
    if (throwPet) this.moveDrag();
    const velocity = this.throwVelocity.release(performance.now());
    this.dragTimer = undefined;
    this.dragOrigin = undefined;
    if (throwPet && this.window && !this.window.isDestroyed()) {
      const bounds = this.petBounds();
      const flight = new ViviFlight(bounds, velocity, this.movementArea(bounds));
      if (flight.active) {
        this.flight = flight;
        this.flightAt = performance.now();
        this.publishDragMotion(false);
        this.flightTimer = setInterval(() => this.moveFlight(), 16);
        return;
      }
    }
    this.publishDragMotion(false);
    if (this.window && !this.window.isDestroyed()) this.setWindowBounds(this.petBounds());
    this.savePosition();
  }

  private stopFlight(): void {
    const flying = Boolean(this.flight);
    if (this.flightTimer) clearInterval(this.flightTimer);
    this.flightTimer = undefined;
    this.flight = undefined;
    if (flying) {
      this.publishDragMotion(false);
      if (this.window && !this.window.isDestroyed()) this.setWindowBounds(this.petBounds());
      this.savePosition();
    }
  }

  private cancelMotion(): void {
    this.mouseHeld = false;
    this.stopDrag(false);
    this.stopFlight();
  }

  private moveFlight(): void {
    if (!this.flight || !this.window || this.window.isDestroyed()) {
      this.stopFlight();
      return;
    }
    const now = performance.now();
    const result = this.flight.step((now - this.flightAt) / 1000);
    this.flightAt = now;
    this.setWindowBounds({ ...result.bounds, x: Math.round(result.bounds.x), y: Math.round(result.bounds.y) });
    this.publishDragMotion(false, result.impact);
    if (!result.active) this.stopFlight();
  }

  private publishDragMotion(dragging: boolean, impact?: ViviImpact): void {
    if (this.disposed || !this.window || this.window.isDestroyed()) return;
    const bounds = this.petBounds();
    const wasMoving = this.moving;
    this.moving = true;
    this.syncNotificationVisibility();
    this.lastMotionAt = Math.max(performance.now(), this.lastMotionAt + 0.001);
    const motion: ViviDragMotion = {
      dragging,
      flying: Boolean(this.flight?.active),
      ...(impact ? { impact } : {}),
      x: bounds.x,
      y: bounds.y,
      size: bounds.width,
      at: this.lastMotionAt,
    };
    broadcast(Ipc.viviDragMotion, motion);
    if (!wasMoving) this.publish();
  }

  private moveDrag(): void {
    if (!this.window || !this.dragOrigin || this.window.isDestroyed()) return;
    const now = performance.now();
    const delta = Math.max(0.004, (now - this.dragAt) / 1000);
    const cursor = screen.getCursorScreenPoint();
    this.throwVelocity.sample(cursor, now);
    const bounds = this.petBounds();
    const intended = {
      ...bounds,
      x: this.dragOrigin.windowX + cursor.x - this.dragOrigin.cursorX,
      y: this.dragOrigin.windowY + cursor.y - this.dragOrigin.cursorY,
    };
    const next = clampViviBounds(intended, this.fullScreenArea() ?? screen.getDisplayNearestPoint(cursor).workArea);
    let impact: ViviImpact | undefined;
    const nx = Math.sign(next.x - intended.x);
    const ny = Math.sign(next.y - intended.y);
    const speed = Math.hypot(nx ? cursor.x - this.dragOrigin.cursorX : 0, ny ? cursor.y - this.dragOrigin.cursorY : 0) / delta;
    if ((nx || ny) && speed > 100 && now - this.lastImpactAt > 160) {
      const normal = Math.hypot(nx, ny);
      impact = { x: nx / normal, y: ny / normal, speed };
      this.lastImpactAt = now;
    }
    this.setWindowBounds(next);
    this.dragAt = now;
    this.dragOrigin = { cursorX: cursor.x, cursorY: cursor.y, windowX: next.x, windowY: next.y };
    this.publishDragMotion(true, impact);
  }

  private savePosition(): void {
    if (!this.window || this.window.isDestroyed() || this.desktopBounds) return;
    const { x, y } = this.petBounds();
    const previous = this.getSettings();
    if (previous.position === "custom" && previous.x === x && previous.y === y) return;
    const settings = this.store.patchSettings({ position: "custom", x, y });
    try {
      this.persistSettings?.(settings);
      this.store.applySettings(settings);
      this.publish();
    } catch (error) {
      log.warn(`Vivi position save failed: ${String(error)}`);
    }
  }

  showContextMenu(onOpen: () => void, onClose: () => Promise<void>): void {
    if (!this.window || this.window.isDestroyed()) return;
    Menu.buildFromTemplate([
      { label: uiText("打开 FastVibe", "Open FastVibe"), click: onOpen },
      { type: "separator" },
      { label: uiText("关闭 Vivi", "Turn off Vivi"), click: () => { void onClose().catch((error: unknown) => log.warn(`Vivi disable failed: ${String(error)}`)); } },
    ]).popup({ window: this.window });
  }

  private applyWindowSettings(previous: ViviSettings): void {
    const settings = this.getSettings();
    if (!settings.enabled) { this.hide(); return; }
    if (!this.window) { this.show(); return; }
    if (this.window.isDestroyed()) return;
    if (settings.scale !== previous.scale || settings.position !== previous.position || settings.x !== previous.x || settings.y !== previous.y) {
      this.cancelMotion();
      this.setWindowBounds(this.boundsFor(settings, screen.getDisplayMatching(this.petBounds())));
      if (settings.position === "custom") this.savePosition();
    }
    this.window.setAlwaysOnTop(settings.alwaysOnTop);
    this.notificationWindow?.setAlwaysOnTop(settings.alwaysOnTop);
    this.syncNotificationVisibility();
    if (!previous.enabled) this.show();
  }

  private keepOnScreen(): void {
    if (!this.window || this.window.isDestroyed()) return;
    const bounds = this.petBounds();
    this.setWindowBounds(clampViviBounds(bounds, this.movementArea(bounds)));
  }

  setBubble(window: BrowserWindow | null, height: number, composerHeight = 0, width?: number, kind: ViviBubbleKind = "notification"): void {
    if (!window || window !== this.notificationWindow || window.isDestroyed() || !Number.isFinite(height) || !Number.isFinite(composerHeight) || (width !== undefined && !Number.isFinite(width))) return;
    const next = Math.max(0, Math.min(460, Math.round(height)));
    const controls = Math.max(0, Math.min(120, Math.round(composerHeight)));
    const measuredWidth = width === undefined ? undefined : Math.max(1, Math.min(360, Math.ceil(width)));
    if (next === this.bubbleHeight && controls === this.composerHeight && measuredWidth === this.bubbleWidth && kind === this.bubbleKind) return;
    const bounds = this.petBounds();
    if (next === 0 && this.bubbleHeight > 0) window.setIgnoreMouseEvents(true, { forward: true });
    this.bubbleHeight = next;
    this.bubbleKind = kind;
    this.composerHeight = controls;
    this.bubbleWidth = measuredWidth;
    this.setWindowBounds(bounds);
    this.publish();
  }

  /** Forward deliberate pet clicks to the separate text window; never replay them. */
  click(window: BrowserWindow | null): void {
    const settings = this.getSettings();
    if (this.disposed || !window || window !== this.window || window.isDestroyed()
      || !this.notificationReady || !this.store.state().visible || !settings.enabled
      || !settings.clickable || this.moving) return;
    broadcast(Ipc.viviClicked, undefined);
  }

  hitTest(window: BrowserWindow | null, interactive: boolean): void {
    if (!window || (window !== this.window && window !== this.notificationWindow) || window.isDestroyed()) return;
    window.setIgnoreMouseEvents(!interactive, { forward: true });
  }

  private petBounds(): Electron.Rectangle {
    return this.window!.getBounds();
  }

  private setWindowBounds(bounds: Electron.Rectangle): void {
    if (!this.window || this.window.isDestroyed()) return;
    const area = this.movementArea(bounds);
    bounds = clampViviBounds(bounds, area);
    const surface = viviNotificationSurfaceLayout(bounds, area, this.bubbleHeight, this.bubbleWidth);
    const previous = this.surface;
    this.surface = surface;
    const current = this.window.getBounds();
    this.updatingSurface = true;
    try {
      if (current.width !== bounds.width || current.height !== bounds.height) this.window.setBounds(bounds, false);
      else if (current.x !== bounds.x || current.y !== bounds.y) this.window.setPosition(bounds.x, bounds.y, false);
      // The text surface may change sides at an edge. It owns no model canvas, so
      // its frame and layout can change without moving the pet for an IPC round trip.
      const notice = this.notificationWindow;
      if (notice && !notice.isDestroyed() && !this.moving) {
        const frame = notice.getBounds();
        if (frame.width !== surface.window.width || frame.height !== surface.window.height) notice.setBounds(surface.window, false);
        else if (frame.x !== surface.window.x || frame.y !== surface.window.y) notice.setPosition(surface.window.x, surface.window.y, false);
      }
    } finally { this.updatingSurface = false; }
    this.syncNotificationVisibility();
    if (JSON.stringify(previous?.pet) !== JSON.stringify(surface.pet) || JSON.stringify(previous?.bubble) !== JSON.stringify(surface.bubble)) this.publish();
  }

  private boundsFor(settings: ViviSettings, display: Electron.Display): Electron.Rectangle {
    return viviBoundsFor(settings, this.fullScreenArea() ?? display.workArea);
  }

  private publish(): void { if (!this.disposed) broadcast(Ipc.viviChanged, this.getSnapshot()); }
}

let petWindow: ViviPetWindow | null = null;
export function getViviPetWindow(): ViviPetWindow { return petWindow ??= new ViviPetWindow(); }
export function destroyViviPetWindow(): void { petWindow?.destroy(); petWindow = null; }
