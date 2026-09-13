import { create } from "zustand";
import type { PermissionMode, QueueBehavior, RunMode, ThinkingLevel } from "@shared/types";

const KEY = "fastvibe.settings";

export type AppSettings = {
  runMode: RunMode;
  permissionMode: PermissionMode;
  thinkingLevel: ThinkingLevel | "auto";
  queueBehavior: QueueBehavior;
  autoCompact: boolean;
  interruptMode: "immediate" | "wait";
  showThinking: boolean;
  showTimestamps: boolean;
  compactCode: boolean;
  sendOnEnter: boolean;
};

const DEFAULTS: AppSettings = {
  runMode: "agent",
  permissionMode: "full",
  thinkingLevel: "auto",
  queueBehavior: "followUp",
  autoCompact: true,
  interruptMode: "immediate",
  showThinking: true,
  showTimestamps: true,
  compactCode: false,
  sendOnEnter: true,
};

function read(): AppSettings {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return DEFAULTS;
    const parsed = JSON.parse(raw) as Partial<AppSettings>;
    return { ...DEFAULTS, ...parsed };
  } catch {
    return DEFAULTS;
  }
}

type SettingsStore = {
  settings: AppSettings;
  update: (patch: Partial<AppSettings>) => void;
  reset: () => void;
};

export const useSettingsStore = create<SettingsStore>((set) => ({
  settings: read(),
  update: (patch) =>
    set((state) => {
      const next = { ...state.settings, ...patch };
      try {
        localStorage.setItem(KEY, JSON.stringify(next));
      } catch {
        // ignore quota errors
      }
      return { settings: next };
    }),
  reset: () => {
    try {
      localStorage.removeItem(KEY);
    } catch {
      // ignore
    }
    set({ settings: DEFAULTS });
  },
}));
