import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import { ViviStateStore } from "../src/main/vivi/state.ts";
import { clampViviBounds, viviBoundsFor, VIVI_BASE_SIZE } from "../src/main/vivi/bounds.ts";
import { ViviFlight, ViviThrowVelocity } from "../src/main/vivi/throw-motion.ts";
import { viviNotificationSurfaceLayout, viviSurfaceLayout } from "../src/main/vivi/panel-bounds.ts";
import { normalizeViviSettings, type ViviDragMotion, type ViviSnapshot } from "../src/shared/vivi.ts";
import { Ipc } from "../src/shared/ipc.ts";

const require = createRequire(import.meta.url);
const ts = require("typescript") as typeof import("typescript");
const compiled = ts.transpileModule(readFileSync(new URL("../src/main/vivi/pet-window.ts", import.meta.url), "utf8"), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;

function fixture(platform = "darwin", create = true) {
  let now = 0;
  let cursor = { x: 500, y: 500 };
  const workArea = { x: 0, y: 24, width: 3000, height: 1800 };
  const display = { workArea };
  const timers = new Set<() => void>();
  const timeouts = new Map<() => void, number>();
  const motions: ViviDragMotion[] = [];
  const snapshots: ViviSnapshot[] = [];
  const saves: unknown[] = [];
  const frameChanges: unknown[] = [];
  class Window extends EventEmitter {
    webContents = Object.assign(new EventEmitter(), { once: (_name: string, _listener: unknown) => undefined });
    bounds: { x: number; y: number; width: number; height: number };
    destroyed = false;
    fullScreen = false;
    parent: Window | null = null;
    options: Record<string, unknown>;
    constructor(options: { x: number; y: number; width: number; height: number }) {
      super();
      this.options = options;
      this.bounds = { x: options.x, y: options.y, width: options.width, height: options.height };
    }
    getBounds() { return { ...this.bounds }; }
    getContentBounds() { return this.getBounds(); }
    getParentWindow() { return this.parent; }
    setParentWindow(parent: Window | null) { this.parent = parent; }
    isFullScreen() { return this.fullScreen; }
    getPosition() { return [this.bounds.x, this.bounds.y]; }
    isDestroyed() { return this.destroyed; }
    setPosition(x: number, y: number) { frameChanges.push({ x, y }); this.bounds = { ...this.bounds, x, y }; this.emit("move"); }
    setBounds(bounds: typeof this.bounds) { frameChanges.push({ ...bounds }); this.bounds = { ...bounds }; this.emit("move"); }
    ignored = false;
    setIgnoreMouseEvents(ignored: boolean) { this.ignored = ignored; }
    setAlwaysOnTop() {}
    showInactive() { this.emit("show"); }
    hide() { this.emit("hide"); }
    destroy() { this.destroyed = true; this.emit("closed"); }
    loadURL() { return Promise.resolve(); }
    loadFile() { return Promise.resolve(); }
  }
  const screen = Object.assign(new EventEmitter(), {
    getCursorScreenPoint: () => ({ ...cursor }),
    getPrimaryDisplay: () => display,
    getDisplayMatching: () => display,
    getDisplayNearestPoint: () => display,
  });
  let window: Window;
  const deps: Record<string, unknown> = {
    electron: { BrowserWindow: class extends Window { constructor(options: ConstructorParameters<typeof Window>[0]) { super(options); window = this; } }, screen, Menu: {} },
    "@shared/ipc": { Ipc },
    "../../shared/vivi": { normalizeViviSettings },
    "../engine/app-settings": { readAppSettings: () => ({ viviEnabled: true, viviPosition: "custom", viviX: 1000, viviY: 600 }) },
    "../engine/paths": { getFastVibePaths: () => ({}) },
    "../engine/logger": { log: { warn() {}, error() {} } },
    "../engine/ui-text": { uiText: (zh: string) => zh },
    "../ipc/broadcast": { broadcast: (channel: string, payload: unknown) => {
      if (channel === Ipc.viviDragMotion) motions.push(payload as ViviDragMotion);
      if (channel === Ipc.viviChanged) snapshots.push(payload as ViviSnapshot);
    } },
    "./state": { ViviStateStore },
    "./bounds": { clampViviBounds, viviBoundsFor, VIVI_BASE_SIZE },
    "./throw-motion": { ViviFlight, ViviThrowVelocity },
    "./panel-bounds": { viviNotificationSurfaceLayout, viviSurfaceLayout },
  };
  const exports = {};
  new Function("require", "exports", "__dirname", "performance", "setInterval", "clearInterval", "setTimeout", "clearTimeout", "process", compiled)(
    (name: string) => {
      if (name in deps) return deps[name];
      if (name.startsWith("node:")) return require(name);
      throw new Error(`Unexpected dependency: ${name}`);
    }, exports, "/tmp/vivi-test", { now: () => now },
    (callback: () => void) => { timers.add(callback); return callback; },
    (callback: () => void) => { timers.delete(callback); },
    (callback: () => void, milliseconds: number) => { timeouts.set(callback, now + milliseconds); return callback; },
    (callback: () => void) => { timeouts.delete(callback); },
    { platform, env: {} },
  );
  const { ViviPetWindow } = exports as typeof import("../src/main/vivi/pet-window.ts");
  const pet = new ViviPetWindow();
  pet.setPersistence((settings) => { saves.push(settings); });
  if (create) pet.create();
  return {
    pet, get window() { return window!; }, Window, screen, motions, snapshots, saves, frameChanges, timers, timeouts,
    mouse(type: "mouseDown" | "mouseUp" | "mouseMove", pressed = false) {
      window.webContents.emit("before-mouse-event", {}, { type, button: "left", modifiers: pressed ? ["leftbuttondown"] : [] });
    },
    tick(dx = 0, dy = 0, milliseconds = 16) {
      cursor = { x: cursor.x + dx, y: cursor.y + dy };
      now += milliseconds;
      for (const [callback, due] of [...timeouts]) {
        if (due <= now && timeouts.delete(callback)) callback();
      }
      for (const callback of [...timers]) if (timers.has(callback)) callback();
    },
  };
}

test("macOS full screen attaches Vivi to the main Space and restores its desktop position", () => {
  const f = fixture();
  const desktop = { x: f.pet.getState().x, y: f.pet.getState().y };
  const main = new f.Window({ x: 3200, y: 0, width: 1440, height: 900 });
  f.pet.setMainWindow(main as never);
  assert.equal(f.window.options.fullscreenable, false);
  assert.equal(f.window.options.maximizable, false);
  assert.equal(f.window.getParentWindow(), null, "the desktop pet stays independent outside full screen");
  main.fullScreen = true;
  main.emit("enter-full-screen");
  assert.equal(f.window.getParentWindow(), main);
  const surface = f.pet.getSnapshot().surface!;
  assert.ok(surface.window.x >= 3200);
  assert.ok(surface.window.x + surface.window.width <= 4640);
  assert.ok(surface.window.y >= 0);
  assert.ok(surface.window.y + surface.window.height <= 900);
  f.pet.setBubble(f.window as never, 120, 0, 360);
  f.mouse("mouseDown", true);
  f.pet.startDrag();
  f.tick(-5000, 2000);
  f.window.emit("blur");
  assert.ok(f.pet.getState().x! >= main.bounds.x);
  assert.ok(f.pet.getState().y! + surface.pet.height <= 900);
  assert.equal(f.saves.length, 0, "full-screen coordinates must not overwrite desktop placement");
  main.fullScreen = false;
  main.emit("leave-full-screen");
  assert.equal(f.window.getParentWindow(), null);
  assert.deepEqual({ x: f.pet.getState().x, y: f.pet.getState().y }, desktop);
  assert.equal(f.saves.length, 0);
  f.pet.destroy();
  assert.equal(main.listenerCount("enter-full-screen"), 0);
  assert.equal(main.listenerCount("leave-full-screen"), 0);
  assert.equal(main.listenerCount("close"), 0);
});

test("entering full screen cancels an active throw without persisting the full-screen position", () => {
  const f = fixture();
  const main = new f.Window({ x: 3200, y: 0, width: 1440, height: 900 });
  f.pet.setMainWindow(main as never);
  f.mouse("mouseDown", true);
  f.pet.startDrag();
  for (let frame = 0; frame < 10; frame++) f.tick(20);
  f.mouse("mouseUp");
  assert.equal(f.motions.at(-1)?.flying, true);
  const desktop = f.pet.getState();
  main.fullScreen = true;
  main.emit("enter-full-screen");
  assert.equal(f.timers.size, 0);
  assert.equal(f.saves.length, 0);
  f.pet.setSettings({ scale: 0.75 });
  main.fullScreen = false;
  main.emit("leave-full-screen");
  assert.equal(f.pet.getState().x, desktop.x);
  assert.equal(f.pet.getState().y, desktop.y);
  assert.equal(f.pet.getSnapshot().surface!.pet.width, 210);
  f.pet.destroy();
});

test("a pet created while the main window is full screen attaches immediately and survives parent close", () => {
  const f = fixture("darwin", false);
  const main = new f.Window({ x: 3200, y: 0, width: 1440, height: 900 });
  main.fullScreen = true;
  f.pet.setMainWindow(main as never);
  f.pet.create();
  assert.equal(f.window.getParentWindow(), main);
  assert.ok(f.pet.getState().x! >= 3200);
  main.emit("close");
  assert.equal(f.window.getParentWindow(), null);
  assert.equal(f.window.isDestroyed(), false);
  assert.equal(f.pet.getState().x, 1000);
  assert.equal(f.pet.getState().y, 600);
  assert.equal(main.listenerCount("enter-full-screen"), 0);
  main.emit("leave-full-screen");
  const replacement = new f.Window({ x: 0, y: 0, width: 1440, height: 900 });
  replacement.fullScreen = true;
  f.pet.setMainWindow(replacement as never);
  assert.equal(f.window.getParentWindow(), replacement);
  f.pet.destroy();
  assert.equal(replacement.listenerCount("close"), 0);
});

test("Windows and Linux pets remain independent of a full-screen workspace", () => {
  for (const platform of ["win32", "linux"]) {
    const f = fixture(platform);
    const before = f.window.getBounds();
    const main = new f.Window({ x: 3200, y: 0, width: 1440, height: 900 });
    main.fullScreen = true;
    f.pet.setMainWindow(main as never);
    main.emit("enter-full-screen");
    assert.equal(f.window.getParentWindow(), null);
    assert.equal(main.listenerCount("enter-full-screen"), 0);
    assert.deepEqual(f.window.getBounds(), before);
    f.pet.destroy();
  }
});

test("workspace focus publishes once per change and pet focus never changes it", () => {
  const f = fixture();
  assert.equal(f.pet.getSnapshot().appFocused, false);
  f.snapshots.length = 0;
  f.pet.setAppFocused(true);
  assert.deepEqual(f.snapshots.map((snapshot) => snapshot.appFocused), [true]);
  f.pet.setAppFocused(true);
  assert.equal(f.snapshots.length, 1);
  f.window.emit("focus");
  f.window.emit("blur");
  assert.equal(f.pet.getSnapshot().appFocused, true);
  assert.equal(f.snapshots.length, 1);
  f.pet.setAppFocused(false);
  assert.deepEqual(f.snapshots.map((snapshot) => snapshot.appFocused), [true, false]);
  f.window.emit("focus");
  assert.equal(f.pet.getSnapshot().appFocused, false);
  f.pet.destroy();
  const count = f.snapshots.length;
  f.pet.setAppFocused(true);
  assert.equal(f.snapshots.length, count, "a disposed pet must not publish focus changes");
});

test("workspace creation, focus, blur and close notify after the window collection is current", () => {
  const f = fixture();
  const source = readFileSync(new URL("../src/main/desktop-window.ts", import.meta.url), "utf8");
  const code = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  class WorkspaceWindow extends EventEmitter {
    focused = false;
    destroyed = false;
    webContents = Object.assign(new EventEmitter(), { setWindowOpenHandler() {} });
    isFocused() { return this.focused; }
    isDestroyed() { return this.destroyed; }
    loadFile() {}
    loadURL() {}
  }
  const deps: Record<string, unknown> = {
    electron: { app: { isPackaged: false }, BrowserWindow: WorkspaceWindow, screen: { getPrimaryDisplay: () => ({ workAreaSize: { width: 1440, height: 900 } }) } },
    "@shared/ipc": { Ipc },
    "./engine/app-settings": { readAppSettings: () => ({}), windowIsGlass: () => false, windowBackgroundColor: () => "#fff", windowVibrancy: () => undefined },
    "./engine/paths": { getFastVibePaths: () => ({}) },
    "./engine/logger": { log: { info() {} } },
    "./engine/startup-timeline": { markStartup() {} },
    "./engine/window-state": { readWindowState: () => undefined },
    "./pi/browser-bridge": { attachBrowserRenderer() {} },
  };
  const exports = {};
  new Function("require", "exports", "__dirname", code)((name: string) => {
    if (name in deps) return deps[name];
    if (name.startsWith("node:")) return require(name);
    throw new Error(`Unexpected dependency: ${name}`);
  }, exports, "/tmp/vivi-test");
  const { createDesktopWindow } = exports as typeof import("../src/main/desktop-window.ts");
  const windows = new Set<WorkspaceWindow>();
  let changes = 0;
  const changed = () => {
    changes++;
    f.pet.setAppFocused([...windows].some((window) => !window.isDestroyed() && window.isFocused()));
  };
  const create = () => createDesktopWindow(windows as never, undefined, changed);
  create();
  assert.equal(changes, 1);
  const first = [...windows][0];
  first.focused = true;
  first.emit("focus");
  assert.equal(f.pet.getSnapshot().appFocused, true);
  first.focused = false;
  first.emit("blur");
  assert.equal(f.pet.getSnapshot().appFocused, false);
  first.focused = true;
  first.emit("focus");
  first.emit("closed");
  assert.equal(windows.size, 0);
  assert.equal(f.pet.getSnapshot().appFocused, false, "closed window must be removed before computing focus");
  create();
  const replacement = [...windows][0];
  assert.notEqual(replacement, first);
  replacement.focused = true;
  replacement.emit("focus");
  assert.equal(f.pet.getSnapshot().appFocused, true);
  replacement.emit("closed");
  f.pet.destroy();
});

test("bubble expansion keeps the model anchored and does not contaminate saved coordinates", () => {
  const f = fixture();
  const before = f.pet.getState();
  f.pet.setBubble(f.window as never, 460);
  const expanded = f.pet.getSnapshot().surface!;
  assert.equal(f.pet.getState().x, before.x);
  assert.equal(f.pet.getState().y, before.y);
  assert.equal(expanded.window.x + expanded.pet.x, before.x);
  assert.equal(expanded.window.y + expanded.pet.y, before.y);
  assert.ok(f.window.getBounds().height > expanded.pet.height);
  f.pet.hitTest(f.window as never, false);
  assert.equal(f.window.ignored, true);
  f.pet.hitTest(f.window as never, true);
  assert.equal(f.window.ignored, false);
  f.mouse("mouseDown", true);
  f.pet.startDrag();
  f.tick(20);
  assert.equal(f.window.getBounds().width, 140);
  assert.equal(f.window.getBounds().height, 140);
  f.window.emit("blur");
  assert.equal(f.pet.getState().x, before.x + 20);
  assert.equal(f.pet.getSettings().x, before.x + 20);
  f.pet.setBubble(f.window as never, 0);
  const hidden = f.pet.getSnapshot().surface!;
  assert.equal(hidden.window.x + hidden.pet.x, before.x + 20);
  assert.equal(hidden.bubble, undefined);
  f.pet.destroy();
});

test("new messages, remeasurement and dismissal never move or resize the native pet frame", () => {
  const f = fixture();
  const initial = f.pet.getSnapshot().surface!;
  f.frameChanges.length = 0;
  for (const [height, width] of [[36, 100], [76, 280], [0, 280], [56, 180], [0, 180], [120, 360]]) {
    f.pet.setBubble(f.window as never, height, 0, width);
    const next = f.pet.getSnapshot().surface!;
    assert.deepEqual(next.window, initial.window);
    assert.deepEqual(next.pet, initial.pet);
    assert.equal(Boolean(next.bubble), height > 0);
  }
  assert.deepEqual(f.frameChanges, [], "no native frame change may precede the renderer's canvas update");
  f.pet.hitTest(f.window as never, true);
  f.pet.setBubble(f.window as never, 0);
  assert.equal(f.window.ignored, true, "closing a notice must immediately release the now-transparent hit area");
  assert.equal(f.saves.length, 0);
  f.pet.destroy();
});

test("completion celebrates for five seconds then returns to idle", () => {
  const f = fixture();
  f.pet.setMood("success", "finished-chat");
  f.tick(0, 0, 4999);
  assert.equal(f.pet.getSnapshot().actors[0].mood, "success");
  f.tick(0, 0, 1);
  assert.equal(f.pet.getSnapshot().actors[0].mood, "idle");
  assert.equal(f.pet.getState().mood, "idle");
  assert.equal(f.pet.getSnapshot().actors[0].conversationId, "finished-chat");
  f.pet.destroy();
});

test("new activity cancels completion expiry and another completion gets its own duration", () => {
  const f = fixture();
  f.pet.setMood("success", "old");
  const staleCallback = [...f.timeouts.keys()][0];
  f.tick(0, 0, 3000);
  f.pet.updateActors([{ id: "new", label: "Task", mood: "waiting", palette: "sky", conversationId: "new" }]);
  assert.equal(f.timeouts.has(staleCallback), false);
  f.tick(0, 0, 3000);
  assert.equal(f.pet.getState().mood, "waiting");
  f.pet.setMood("success", "new");
  f.tick(0, 0, 4000);
  f.pet.setMood("success", "another");
  f.tick(0, 0, 2000);
  assert.equal(f.pet.getState().mood, "success");
  f.tick(0, 0, 3000);
  assert.equal(f.pet.getState().mood, "idle");
  f.pet.setMood("success");
  f.pet.destroy();
  assert.equal(f.timeouts.size, 0);
});

test("native release ends following even if the renderer never sends dragEnd", () => {
  const f = fixture();
  f.mouse("mouseDown", true);
  f.pet.startDrag();
  for (let frame = 0; frame < 12; frame++) f.tick(16, -2);
  f.mouse("mouseUp");
  assert.equal(f.motions.at(-1)?.dragging, false);
  assert.equal(f.motions.at(-1)?.flying, true);
  const follow = f.window.getBounds();
  for (let frame = 0; frame < 250; frame++) f.tick(-100, 100);
  assert.equal(f.timers.size, 0);
  assert.equal(f.motions.at(-1)?.flying, false);
  assert.ok(f.window.getBounds().x > follow.x);
  assert.equal(f.saves.length, 1, "save landing position once, never every flight frame");
  f.pet.destroy();
});

test("buttons-up movement and delayed dragStart cannot latch onto a released mouse", () => {
  const f = fixture();
  f.mouse("mouseDown", true);
  f.mouse("mouseUp");
  f.pet.startDrag();
  assert.equal(f.timers.size, 0);
  f.mouse("mouseDown", true);
  f.pet.startDrag();
  f.tick(15);
  f.mouse("mouseMove", false);
  assert.equal(f.motions.at(-1)?.dragging, false);
  f.pet.startDrag();
  assert.equal(f.motions.at(-1)?.dragging, false);
  f.pet.destroy();
  assert.equal(f.timers.size, 0);
});

test("grabbing a flying pet cancels its old flight before a new drag begins", () => {
  const f = fixture();
  f.mouse("mouseDown", true);
  f.pet.startDrag();
  for (let frame = 0; frame < 10; frame++) f.tick(20);
  f.mouse("mouseUp");
  assert.equal(f.motions.at(-1)?.flying, true);
  f.tick();
  f.mouse("mouseDown", true);
  assert.equal(f.timers.size, 0);
  const caught = f.pet.getState();
  f.pet.startDrag();
  assert.equal(f.timers.size, 1);
  f.tick(-12);
  assert.equal(f.pet.getState().x, caught.x - 12);
  assert.equal(f.motions.at(-1)?.dragging, true);
  f.pet.hide();
  assert.equal(f.timers.size, 0);
  f.pet.destroy();
});

test("native blur, hiding, reload and display changes stop motion without throwing", () => {
  for (const cancel of [
    (f: ReturnType<typeof fixture>) => f.window.emit("blur"),
    (f: ReturnType<typeof fixture>) => f.pet.hide(),
    (f: ReturnType<typeof fixture>) => f.window.webContents.emit("did-start-loading"),
    (f: ReturnType<typeof fixture>) => f.screen.emit("display-removed"),
  ]) {
    const f = fixture();
    f.mouse("mouseDown", true);
    f.pet.startDrag();
    for (let frame = 0; frame < 5; frame++) f.tick(24);
    cancel(f);
    assert.equal(f.timers.size, 0);
    assert.equal(f.motions.at(-1)?.dragging, false);
    assert.equal(f.motions.at(-1)?.flying, false);
    const stopped = f.window.getBounds();
    f.tick(500);
    assert.deepEqual(f.window.getBounds(), stopped);
    f.pet.destroy();
  }
});

test("dragging into the edge publishes impact feedback and never leaves the work area", () => {
  const f = fixture();
  const offset = f.pet.getSnapshot().surface!.pet;
  f.window.setPosition(2855 - offset.x, 600 - offset.y);
  f.mouse("mouseDown", true);
  f.pet.startDrag();
  f.tick(100);
  assert.equal(f.window.getBounds().x, 2860);
  assert.ok(f.motions.at(-1)?.impact);
  assert.equal(f.motions.at(-1)?.impact?.x, -1);
  f.mouse("mouseUp");
  let impacts = 0;
  for (let frame = 0; frame < 220; frame++) {
    f.tick();
    const bounds = f.window.getBounds();
    assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= 3000);
    if (f.motions.at(-1)?.impact) impacts++;
  }
  assert.ok(impacts > 0);
  f.pet.destroy();
});
