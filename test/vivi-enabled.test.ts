import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import { Ipc } from "../src/shared/ipc.ts";

const require = createRequire(import.meta.url);
const ts = require("typescript") as typeof import("typescript");
const compiled = ts.transpileModule(readFileSync(new URL("../src/main/vivi/ipc-handlers.ts", import.meta.url), "utf8"), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;

function fixture() {
  let enabled = true;
  let close: (() => Promise<void>) | undefined;
  let queue = Promise.resolve();
  const changes: boolean[] = [];
  const handlers = new Map<string, (...args: any[]) => any>();
  const pet = {
    setPersistence() {},
    getSettings: () => ({ enabled }),
    setSettings: (patch: { enabled: boolean }) => { enabled = patch.enabled; changes.push(enabled); },
    getState: () => ({ visible: false }),
    showContextMenu: (_open: unknown, onClose: () => Promise<void>) => { close = onClose; },
  };
  const deps: Record<string, unknown> = {
    "@shared/ipc": { Ipc },
    "@shared/vivi": { viviSettingsPatch: (value: unknown) => value },
    "../ipc/registry": { handle: (channel: string, handler: (...args: any[]) => any) => handlers.set(channel, handler) },
    "./pet-window": { getViviPetWindow: () => pet },
    "../engine/paths": {},
    "../engine/app-settings": {},
  };
  const exports = {};
  new Function("require", "exports", compiled)((name: string) => {
    if (name in deps) return deps[name];
    throw new Error(`Unexpected dependency: ${name}`);
  }, exports);
  const { registerViviIpc } = exports as typeof import("../src/main/vivi/ipc-handlers.ts");
  registerViviIpc({
    queueSettingsWrite: (task) => { queue = queue.then(task); return queue; },
    openConversation: async () => undefined,
  });
  return { changes, pet, call: (channel: string) => handlers.get(channel)!(), close: () => close!() };
}

test("context menu turns off the persisted enabled preference through the settings queue", async () => {
  const f = fixture();
  f.call(Ipc.viviContextMenu);
  await f.close();
  assert.equal(f.pet.getSettings().enabled, false);
  assert.deepEqual(f.changes, [false]);
});

test("legacy show, hide and toggle calls all use enabled instead of hidden window state", async () => {
  const f = fixture();
  assert.equal(f.pet.getState().visible, false);
  assert.equal(await f.call(Ipc.viviToggle), false);
  await f.call(Ipc.viviShow);
  assert.equal(f.pet.getSettings().enabled, true);
  await f.call(Ipc.viviHide);
  assert.equal(f.pet.getSettings().enabled, false);
  const first = f.call(Ipc.viviToggle);
  const second = f.call(Ipc.viviToggle);
  await Promise.all([first, second]);
  assert.equal(f.pet.getSettings().enabled, false);
  assert.deepEqual(f.changes, [false, true, false, true, false]);
});
