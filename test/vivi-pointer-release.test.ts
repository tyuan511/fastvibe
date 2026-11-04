import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const ts = require("typescript") as typeof import("typescript");
const compiled = ts.transpileModule(readFileSync(new URL("../src/renderer/src/vivi/main.ts", import.meta.url), "utf8"), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;

async function fixture(deferStart = false) {
  const calls: string[] = [];
  let releaseStart: (() => void) | undefined;
  let motionListener: ((motion: unknown) => void) | undefined;
  let captures = new Set<number>();
  class Element {
    listeners = new Map<string, Array<(event: any) => void>>();
    style = { setProperty() {} };
    classList = { toggle() {} };
    textContent = "";
    disabled = false;
    addEventListener(name: string, listener: (event: any) => void) {
      const handlers = this.listeners.get(name) ?? [];
      handlers.push(listener);
      this.listeners.set(name, handlers);
    }
    emit(name: string, overrides = {}) {
      const event = { pointerId: 1, button: 0, buttons: 1, clientX: 10, clientY: 10, preventDefault() {}, ...overrides };
      for (const listener of this.listeners.get(name) ?? []) listener(event);
    }
    setAttribute() {}
    replaceChildren() {}
    append() {}
    getBoundingClientRect() { return { left: 0, top: 0, width: 140, height: 140 }; }
    setPointerCapture(id: number) { captures.add(id); }
    hasPointerCapture(id: number) { return captures.has(id); }
    releasePointerCapture(id: number) { captures.delete(id); this.emit("lostpointercapture", { pointerId: id }); }
  }
  const canvas = new Element();
  const doc = Object.assign(new Element(), {
    hidden: false,
    body: new Element(),
    querySelector: (selector: string) => selector === "#vivi-canvas" ? canvas : new Element(),
    createElement: () => new Element(),
  });
  const snapshot = { visible: true, settings: { enabled: true, clickable: true, opacity: 1 }, actors: [{ id: "vivi", label: "Vivi" }] };
  const api = {
    getSnapshot: async () => snapshot,
    rendererState: async () => undefined,
    onChanged: () => () => undefined,
    onDragMotion: (listener: typeof motionListener) => { motionListener = listener; return () => undefined; },
    dragStart: async () => {
      calls.push("start");
      if (deferStart) await new Promise<void>((resolve) => { releaseStart = resolve; });
    },
    dragEnd: async () => { calls.push("end"); },
    openConversation: async () => { calls.push("open"); },
    click: async () => { calls.push("feedback"); },
    contextMenu: async () => undefined,
  };
  const win = Object.assign(new Element(), { location: { search: "" }, fastvibe: { vivi: api } });
  const scene = {
    setActors() {}, setClickable() {}, setVisible() {}, setDragMotion() {}, prepareFrame() {}, cleanup() {},
    hitTest: () => "vivi", getActorScreenPosition: () => null, poke: () => { calls.push("poke"); },
  };
  new Function("require", "exports", "window", "document", "navigator", "performance", "setTimeout", "clearTimeout", "Element", compiled)(
    (name: string) => name.endsWith("vivi-renderer") ? { initializeViviScene: async () => scene }
      : name.endsWith("agent-bubble") ? { mountViviBubble: () => () => undefined, updateViviBubble() {}, setViviBubbleMoving() {}, showViviClickFeedback() {}, noteViviMotion() {}, noteViviHover() {} } : {},
    {}, win, doc, { language: "en" }, { now: () => 1000 }, () => 1, () => undefined, Element,
  );
  const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
  await flush();
  return {
    canvas, win, doc, calls, flush,
    releaseStart: () => releaseStart?.(),
    motion: (motion: unknown) => motionListener?.(motion),
    grab() { canvas.emit("pointerdown"); canvas.emit("pointermove", { clientX: 20 }); },
  };
}

test("lost pointer capture, buttons-up movement and outside release all end a drag", async () => {
  for (const release of [
    (f: Awaited<ReturnType<typeof fixture>>) => f.canvas.emit("lostpointercapture"),
    (f: Awaited<ReturnType<typeof fixture>>) => f.win.emit("pointermove", { buttons: 0 }),
    (f: Awaited<ReturnType<typeof fixture>>) => f.win.emit("pointerup", { buttons: 0 }),
    (f: Awaited<ReturnType<typeof fixture>>) => f.win.emit("pointercancel", { buttons: 0 }),
  ]) {
    const f = await fixture();
    f.grab();
    await f.flush();
    release(f);
    await f.flush();
    assert.deepEqual(f.calls, ["start", "end"]);
  }
});

test("release before async start finishes queues stop after start and cannot latch", async () => {
  const f = await fixture(true);
  f.grab();
  await f.flush();
  f.win.emit("pointerup", { buttons: 0 });
  await f.flush();
  assert.deepEqual(f.calls, ["start"]);
  f.releaseStart();
  await f.flush();
  assert.deepEqual(f.calls, ["start", "end"]);
});

test("release before queued start skips the stale start", async () => {
  const f = await fixture();
  f.grab();
  f.win.emit("pointerup", { buttons: 0 });
  await f.flush();
  assert.deepEqual(f.calls, ["end"]);
});

test("old flight messages cannot cancel a newly grabbed pointer", async () => {
  const f = await fixture();
  f.canvas.emit("pointerdown");
  f.motion({ dragging: false, flying: true });
  f.canvas.emit("pointermove", { clientX: 30 });
  await f.flush();
  assert.deepEqual(f.calls, ["start"]);
  f.win.emit("pointerup", { buttons: 0 });
  await f.flush();
  assert.deepEqual(f.calls, ["start", "end"]);
});

test("cancelling a click does not poke, while ordinary click and doubleclick still work", async () => {
  const f = await fixture();
  f.canvas.emit("pointerdown");
  f.canvas.emit("lostpointercapture");
  f.canvas.emit("pointerup", { buttons: 0 });
  await f.flush();
  assert.deepEqual(f.calls, []);
  f.canvas.emit("pointerdown");
  f.win.emit("pointerup", { buttons: 0 });
  f.canvas.emit("pointerdown");
  f.win.emit("pointerup", { buttons: 0 });
  await f.flush();
  assert.deepEqual(f.calls, ["poke", "feedback", "open"]);
});
