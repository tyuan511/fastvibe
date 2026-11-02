import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import { ViviStateStore } from "../src/main/vivi/state.ts";
import { clampViviBounds, viviBoundsFor, VIVI_BASE_SIZE } from "../src/main/vivi/bounds.ts";
import { ViviFlight, ViviThrowVelocity } from "../src/main/vivi/throw-motion.ts";
import { viviSurfaceLayout } from "../src/main/vivi/panel-bounds.ts";
import { normalizeViviSettings, type ViviDragMotion } from "../src/shared/vivi.ts";
import { Ipc } from "../src/shared/ipc.ts";

const require = createRequire(import.meta.url);
const ts = require("typescript") as typeof import("typescript");
const compiled = ts.transpileModule(readFileSync(new URL("../src/main/vivi/pet-window.ts", import.meta.url), "utf8"), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;

function fixture() {
  let now = 0;
  let cursor = { x: 500, y: 500 };
  const workArea = { x: 0, y: 24, width: 3000, height: 1800 };
  const display = { workArea };
  const timers = new Set<() => void>();
  const timeouts = new Map<() => void, number>();
  const motions: ViviDragMotion[] = [];
  const saves: unknown[] = [];
  class Window extends EventEmitter {
    webContents = Object.assign(new EventEmitter(), { once: (_name: string, _listener: unknown) => undefined });
    bounds: { x: number; y: number; width: number; height: number };
    destroyed = false;
    constructor(options: { x: number; y: number; width: number; height: number }) {
      super();
      this.bounds = { x: options.x, y: options.y, width: options.width, height: options.height };
    }
    getBounds() { return { ...this.bounds }; }
    getPosition() { return [this.bounds.x, this.bounds.y]; }
    isDestroyed() { return this.destroyed; }
    setPosition(x: number, y: number) { this.bounds = { ...this.bounds, x, y }; this.emit("move"); }
    setBounds(bounds: typeof this.bounds) { this.bounds = { ...bounds }; this.emit("move"); }
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
    "../ipc/broadcast": { broadcast: (channel: string, payload: unknown) => { if (channel === Ipc.viviDragMotion) motions.push(payload as ViviDragMotion); } },
    "./state": { ViviStateStore },
    "./bounds": { clampViviBounds, viviBoundsFor, VIVI_BASE_SIZE },
    "./throw-motion": { ViviFlight, ViviThrowVelocity },
    "./panel-bounds": { viviSurfaceLayout },
  };
  const exports = {};
  new Function("require", "exports", "__dirname", "performance", "setInterval", "clearInterval", "setTimeout", "clearTimeout", compiled)(
    (name: string) => {
      if (name in deps) return deps[name];
      if (name.startsWith("node:")) return require(name);
      throw new Error(`Unexpected dependency: ${name}`);
    }, exports, "/tmp/vivi-test", { now: () => now },
    (callback: () => void) => { timers.add(callback); return callback; },
    (callback: () => void) => { timers.delete(callback); },
    (callback: () => void, milliseconds: number) => { timeouts.set(callback, now + milliseconds); return callback; },
    (callback: () => void) => { timeouts.delete(callback); },
  );
  const { ViviPetWindow } = exports as typeof import("../src/main/vivi/pet-window.ts");
  const pet = new ViviPetWindow();
  pet.setPersistence((settings) => { saves.push(settings); });
  pet.create();
  return {
    pet, window: window!, screen, motions, saves, timers, timeouts,
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
  assert.equal(f.window.getBounds().x, before.x + 20);
  assert.equal(f.window.getBounds().width, 140);
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
  const caught = f.window.getBounds();
  f.pet.startDrag();
  assert.equal(f.timers.size, 1);
  f.tick(-12);
  assert.equal(f.window.getBounds().x, caught.x - 12);
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
  f.window.setPosition(2855, 600);
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
