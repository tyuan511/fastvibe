import assert from "node:assert/strict";
import test from "node:test";
import { ViviStateStore } from "../src/main/vivi/state.ts";
import { mergeClientSettings } from "../src/shared/settings-merge.ts";
import { DEFAULT_VIVI_SETTINGS, viviSettingsPatch, type ViviDragMotion, type ViviSnapshot } from "../src/shared/vivi.ts";
import { Ipc } from "../src/shared/ipc.ts";
import { createAppServer, initAppServer, resetAppServerRuntime } from "../src/main/app-server/runtime.ts";
import { attachWindowSession } from "../src/main/transport/window-session.ts";
import { broadcast } from "../src/main/ipc/broadcast.ts";

const moods = ["idle", "thinking", "working", "waiting", "success", "error"] as const;
const palettes = ["sky", "grape", "mint", "peach", "cloud"] as const;

test("previewing each mood changes the actor consumed by the desktop renderer", () => {
  const state = new ViviStateStore({});
  for (const mood of moods) {
    state.setMood(mood);
    assert.equal(state.snapshot().actors[0]?.mood, mood);
    assert.equal(state.state().mood, mood);
  }
});

test("saved palettes reach the same actor and survive engine activity and reopening", () => {
  const state = new ViviStateStore({});
  for (const palette of palettes) {
    state.applySettings(state.patchSettings({ palette }));
    state.follow([{ id: "chat", label: "Task", mood: "working", palette: "sky", conversationId: "chat" }]);
    assert.equal(state.snapshot().actors[0]?.palette, palette);
    assert.equal(new ViviStateStore(viviSettingsPatch(state.settings())).snapshot().actors[0]?.palette, palette);
  }
  state.follow([]);
  assert.equal(state.snapshot().actors.length, 1);
  assert.equal(state.snapshot().actors[0]?.mood, "idle");
});

test("messages default to enabled and ignore invalid stored values", () => {
  for (const value of [undefined, null, "false", 0, 1, {}]) {
    assert.equal(new ViviStateStore({ viviMessages: value }).settings().messages, true);
  }
  assert.equal(new ViviStateStore({ viviMessages: true }).settings().messages, true);
});

test("disabling messages survives reopening without hiding or changing the pet", () => {
  const state = new ViviStateStore({ viviEnabled: true });
  state.setVisible(true);
  state.setMood("working", "chat");
  const before = state.snapshot();
  state.applySettings(state.patchSettings({ messages: false }));
  const snapshot = state.snapshot();
  assert.equal(snapshot.settings.messages, false);
  assert.equal(snapshot.settings.enabled, true);
  assert.equal(snapshot.visible, true);
  assert.deepEqual(snapshot.actors, before.actors);
  const persisted = viviSettingsPatch(state.settings());
  assert.equal(persisted.viviMessages, false);
  const reopened = new ViviStateStore(persisted);
  assert.equal(reopened.settings().messages, false);
  assert.equal(reopened.settings().enabled, true);
  reopened.applySettings(reopened.patchSettings({ messages: true }));
  assert.equal(new ViviStateStore(viviSettingsPatch(reopened.settings())).settings().messages, true);
});

test("old multi-agent preferences cannot create multiple pets", () => {
  const state = new ViviStateStore({ viviMultiAgent: true });
  state.follow([
    { id: "a", label: "A", mood: "working", palette: "sky" },
    { id: "b", label: "B", mood: "waiting", palette: "grape" },
  ]);
  assert.equal(state.snapshot().actors.length, 1);
  assert.equal(state.snapshot().actors[0]?.mood, "waiting");
  assert.equal("multiAgent" in state.settings(), false);
});

test("unrelated stale settings saves preserve Vivi preferences", () => {
  const current = { ...viviSettingsPatch({ ...DEFAULT_VIVI_SETTINGS, enabled: true, messages: false, palette: "mint" }), glass: true };
  const saved = mergeClientSettings(current, { ...viviSettingsPatch(DEFAULT_VIVI_SETTINGS), glass: false });
  assert.equal(saved.viviEnabled, true);
  assert.equal(saved.viviPalette, "mint");
  assert.equal(saved.viviMessages, false);
  assert.equal(saved.glass, false);
  assert.equal(mergeClientSettings({}, { viviEnabled: true }).viviEnabled, undefined);
});

test("preview and palette changes push matching snapshots to settings and the pet window", async () => {
  resetAppServerRuntime();
  const state = new ViviStateStore({});
  const server = createAppServer({
    identity: { serverInstanceId: "vivi_test", version: "1", platform: "darwin" },
    channels: () => [Ipc.viviGetSnapshot, Ipc.viviSetSettings, Ipc.viviPreviewMood],
  });
  initAppServer({ dispatch: async (method, payload) => {
    if (method === Ipc.viviSetSettings) state.applySettings(state.patchSettings(payload as { palette: "mint" }));
    if (method === Ipc.viviPreviewMood) state.setMood((payload as { mood: "success" }).mood);
    broadcast(Ipc.viviChanged, state.snapshot());
    return state.snapshot();
  } });
  const settingsEvents: ViviSnapshot[] = [];
  const petEvents: ViviSnapshot[] = [];
  const attach = (origin: string, events: ViviSnapshot[]) => attachWindowSession(server, {
    origin,
    sendToRenderer: (channel, payload) => { if (channel === Ipc.viviChanged) events.push(payload as ViviSnapshot); },
  });
  const settings = attach("window:settings", settingsEvents);
  const pet = attach("window:pet", petEvents);
  try {
    await Promise.all([settings.ready, pet.ready]);
    await settings.call(Ipc.viviSetSettings, { palette: "mint" });
    await settings.call(Ipc.viviPreviewMood, { mood: "success" });
    for (let attempt = 0; attempt < 40 && (settingsEvents.length < 2 || petEvents.length < 2); attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.deepEqual(settingsEvents, petEvents);
    assert.equal(petEvents.at(-1)?.actors[0]?.palette, "mint");
    assert.equal(petEvents.at(-1)?.actors[0]?.mood, "success");
    assert.equal(petEvents.at(-1)?.settings.palette, "mint");
  } finally {
    settings.dispose(); pet.dispose(); resetAppServerRuntime();
  }
});

test("window sessions deliver drag samples and release in order", async () => {
  resetAppServerRuntime();
  const server = createAppServer({
    identity: { serverInstanceId: "vivi_motion_test", version: "1", platform: "darwin" },
    channels: () => [Ipc.viviDragStart, Ipc.viviDragEnd],
  });
  initAppServer({ dispatch: async () => undefined });
  const motions: ViviDragMotion[] = [];
  const pet = attachWindowSession(server, {
    origin: "window:pet-motion",
    sendToRenderer: (channel, payload) => { if (channel === Ipc.viviDragMotion) motions.push(payload as ViviDragMotion); },
  });
  const expected = [
    { dragging: true, x: -120, y: 30, size: 140, at: 100 },
    { dragging: true, x: -95, y: 35, size: 140, at: 116 },
    { dragging: false, x: -95, y: 35, size: 140, at: 120 },
  ];
  try {
    await pet.ready;
    for (const sample of expected) broadcast(Ipc.viviDragMotion, sample);
    for (let attempt = 0; attempt < 40 && motions.length < expected.length; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.deepEqual(motions, expected);
  } finally {
    pet.dispose();
    resetAppServerRuntime();
  }
});
