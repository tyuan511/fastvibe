export type ViviMood = "idle" | "thinking" | "working" | "waiting" | "success" | "error";
export type ViviPalette = "sky" | "grape" | "mint" | "peach" | "cloud";
export type ViviPosition = "top-left" | "top-right" | "bottom-left" | "bottom-right" | "custom";

export type ViviSettings = {
  enabled: boolean;
  messages: boolean;
  palette: ViviPalette;
  scale: number;
  opacity: number;
  clickable: boolean;
  alwaysOnTop: boolean;
  position: ViviPosition;
  x?: number;
  y?: number;
};

export type ViviActor = {
  id: string;
  label: string;
  mood: ViviMood;
  palette: ViviPalette;
  conversationId?: string;
};

export type ViviState = {
  mood: ViviMood;
  palette: ViviPalette;
  visible: boolean;
  x: number;
  y: number;
  scale: number;
  opacity: number;
  conversationId?: string;
};

export type ViviImpact = {
  /** Inward screen-space normal and incoming speed in DIPs per second. */
  x: number;
  y: number;
  speed: number;
};

export type ViviDragMotion = {
  dragging: boolean;
  flying?: boolean;
  impact?: ViviImpact;
  x: number;
  y: number;
  /** Main-process monotonic milliseconds; coordinates and size are screen DIPs. */
  at: number;
  size: number;
};

export type ViviSurfaceLayout = {
  window: { x: number; y: number; width: number; height: number };
  pet: { x: number; y: number; width: number; height: number };
  bubble?: { x: number; y: number; width: number; height: number };
  composer?: { x: number; y: number; width: number; height: number };
};

export type ViviSnapshot = {
  settings: ViviSettings;
  actors: ViviActor[];
  visible: boolean;
  /** Whether a FastVibe workspace window is focused; the pet itself is excluded. */
  appFocused?: boolean;
  surface?: ViviSurfaceLayout;
  uiLanguage?: "zh" | "en";
  error?: string;
};

export const VIVI_PALETTES: Record<ViviPalette, {
  name: string;
  stops: readonly [string, string, string];
  feet: string;
}> = {
  sky: { name: "天空", stops: ["#7cc6ff", "#3f84f8", "#4a36d8"], feet: "#4336cf" },
  grape: { name: "葡萄", stops: ["#ecd4ff", "#a670ff", "#5a2fd6"], feet: "#4824b4" },
  mint: { name: "薄荷", stops: ["#d2fff1", "#3fd2b2", "#14898d"], feet: "#0e7275" },
  peach: { name: "蜜桃", stops: ["#ffe6cc", "#ff9b72", "#e5506c"], feet: "#c33f58" },
  cloud: { name: "云朵", stops: ["#ffffff", "#f3f6ff", "#c8d3ff"], feet: "#b1bff9" },
};

export const DEFAULT_VIVI_SETTINGS: ViviSettings = {
  enabled: false,
  messages: true,
  palette: "sky",
  scale: 0.5,
  opacity: 0.9,
  clickable: true,
  alwaysOnTop: true,
  position: "bottom-right",
};

export function isViviPalette(value: unknown): value is ViviPalette {
  return typeof value === "string" && value in VIVI_PALETTES;
}

export function isViviPosition(value: unknown): value is ViviPosition {
  return value === "top-left" || value === "top-right" || value === "bottom-left" || value === "bottom-right" || value === "custom";
}

export function normalizeViviSettings(settings: Record<string, unknown>): ViviSettings {
  const result: ViviSettings = { ...DEFAULT_VIVI_SETTINGS };
  if (typeof settings.viviEnabled === "boolean") result.enabled = settings.viviEnabled;
  if (typeof settings.viviMessages === "boolean") result.messages = settings.viviMessages;
  if (isViviPalette(settings.viviPalette)) result.palette = settings.viviPalette;
  if (typeof settings.viviScale === "number" && Number.isFinite(settings.viviScale)) result.scale = Math.min(1.5, Math.max(0.3, settings.viviScale));
  if (typeof settings.viviOpacity === "number" && Number.isFinite(settings.viviOpacity)) result.opacity = Math.min(1, Math.max(0.3, settings.viviOpacity));
  if (typeof settings.viviClickable === "boolean") result.clickable = settings.viviClickable;
  if (typeof settings.viviAlwaysOnTop === "boolean") result.alwaysOnTop = settings.viviAlwaysOnTop;
  if (isViviPosition(settings.viviPosition)) result.position = settings.viviPosition;
  if (typeof settings.viviX === "number" && Number.isFinite(settings.viviX)) result.x = Math.round(settings.viviX);
  if (typeof settings.viviY === "number" && Number.isFinite(settings.viviY)) result.y = Math.round(settings.viviY);
  return result;
}

export function viviSettingsPatch(settings: ViviSettings): Record<string, unknown> {
  return {
    viviEnabled: settings.enabled,
    viviMessages: settings.messages,
    viviPalette: settings.palette,
    viviScale: settings.scale,
    viviOpacity: settings.opacity,
    viviClickable: settings.clickable,
    viviAlwaysOnTop: settings.alwaysOnTop,
    viviPosition: settings.position,
    ...(settings.x === undefined ? {} : { viviX: settings.x }),
    ...(settings.y === undefined ? {} : { viviY: settings.y }),
  };
}

export const MOODS_INFO: Record<ViviMood, { name: string; note: string; say: string }> = {
  idle: { name: "空闲", note: "慢慢呼吸，偶尔眨眼", say: "在呢～" },
  thinking: { name: "思考", note: "盯着闪光，闪光在转", say: "让我想想…" },
  working: { name: "执行", note: "一蹦一蹦地干活", say: "正在干活！" },
  waiting: { name: "等你", note: "晃脑袋，闪光一闪一闪", say: "等你确认一下" },
  success: { name: "完成", note: "跳起来，闪光炸开", say: "搞定啦！" },
  error: { name: "出错", note: "塌下来，冒一滴冷汗", say: "呜…出错了" },
};
