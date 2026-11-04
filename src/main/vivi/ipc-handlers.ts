import { Ipc } from "@shared/ipc";
import type { ViviMood, ViviSettings } from "@shared/vivi";
import { viviSettingsPatch } from "@shared/vivi";
import { handle } from "../ipc/registry";
import { getViviPetWindow } from "./pet-window";
import { getFastVibePaths } from "../engine/paths";
import { readAppSettings, writeAppSettings } from "../engine/app-settings";

type ViviIpcOptions = {
  queueSettingsWrite: (task: () => Promise<void>) => Promise<void>;
  openConversation: (conversationId?: string, runId?: string) => Promise<void>;
};

export function registerViviIpc(options: ViviIpcOptions): void {
  const pet = getViviPetWindow();
  pet.setPersistence((settings) => {
    const current = { ...readAppSettings(getFastVibePaths()) };
    for (const key of Object.keys(current)) if (key.startsWith("vivi")) delete current[key];
    writeAppSettings(getFastVibePaths(), { ...current, ...viviSettingsPatch(settings) });
  });

  handle(Ipc.viviGetSettings, () => pet.getSettings());
  handle(Ipc.viviSetSettings, async (payload: Partial<ViviSettings>) => {
    await options.queueSettingsWrite(async () => { pet.setSettings(payload ?? {}); });
    return pet.getSettings();
  });
  handle(Ipc.viviGetState, () => pet.getState());
  handle(Ipc.viviGetSnapshot, () => pet.getSnapshot());
  handle(Ipc.viviRendererState, (payload: { ready?: boolean; error?: string }, ctx) => {
    pet.rendererState(ctx.window, payload?.ready === true, typeof payload?.error === "string" ? payload.error : undefined);
  });
  handle(Ipc.viviMotionSettled, (payload: { at?: number }, ctx) => pet.motionSettled(ctx.window, payload?.at ?? NaN));
  handle(Ipc.viviSetBubble, (payload: { height?: number; composerHeight?: number; width?: number; kind?: string }, ctx) => pet.setBubble(ctx.window, payload?.height ?? 0, payload?.composerHeight ?? 0, payload?.width, payload?.kind === "feedback" ? "feedback" : "notification"));
  handle(Ipc.viviHitTest, (payload: { interactive?: boolean }, ctx) => pet.hitTest(ctx.window, payload?.interactive === true));
  handle(Ipc.viviClick, (_payload, ctx) => pet.click(ctx.window));
  const setEnabled = (enabled: boolean): Promise<void> => options.queueSettingsWrite(async () => { pet.setSettings({ enabled }); });
  handle(Ipc.viviShow, () => setEnabled(true));
  handle(Ipc.viviHide, () => setEnabled(false));
  handle(Ipc.viviToggle, async () => {
    await options.queueSettingsWrite(async () => { pet.setSettings({ enabled: !pet.getSettings().enabled }); });
    return pet.getSettings().enabled;
  });
  handle(Ipc.viviResetPosition, async () => {
    await options.queueSettingsWrite(async () => { pet.resetPosition(); });
    return pet.getSettings();
  });
  handle(Ipc.viviPreviewMood, (payload: { mood?: string }) => pet.setMood(normalizeMood(payload?.mood)));
  handle(Ipc.viviDragStart, () => pet.startDrag());
  handle(Ipc.viviDragEnd, () => pet.stopDrag());
  handle(Ipc.viviOpenConversation, (payload: { conversationId?: string; runId?: string }) => {
    const id = typeof payload?.conversationId === "string" ? payload.conversationId : undefined;
    const runId = typeof payload?.runId === "string" ? payload.runId : undefined;
    return options.openConversation(id, runId);
  });
  handle(Ipc.viviContextMenu, () => {
    pet.showContextMenu(
      () => { void options.openConversation().catch(() => undefined); },
      () => setEnabled(false),
    );
  });
}

function normalizeMood(value: string | undefined): ViviMood {
  return value === "thinking" || value === "working" || value === "waiting" || value === "success" || value === "error" ? value : "idle";
}
