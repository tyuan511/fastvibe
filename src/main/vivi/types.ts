/**
 * Vivi: FastVibe's desktop pet mascot
 * A soft blob with a sparkle, driven by agent states and rendered in 3D.
 */

export type ViviMood = "idle" | "thinking" | "working" | "waiting" | "success" | "error";
export type ViviPalette = "sky" | "grape" | "mint" | "peach" | "cloud";

export interface ViviState {
  mood: ViviMood;
  palette: ViviPalette;
  visible: boolean;
  x: number;
  y: number;
  scale: number;
  opacity: number;
}

export interface ViviSettings {
  enabled: boolean;
  palette: ViviPalette;
  scale: number;
  opacity: number;
  clickable: boolean;
  alwaysOnTop: boolean;
}

export interface GLTFAsset {
  scene: any;
  animations: any[];
  parser: any;
}

export const MOODS_INFO: Record<ViviMood, { name: string; note: string; say: string }> = {
  idle: { name: "空闲", note: "慢慢呼吸，偶尔眨眼", say: "在呢～" },
  thinking: { name: "思考", note: "盯着闪光，闪光在转", say: "让我想想…" },
  working: { name: "执行", note: "一蹦一蹦地干活", say: "正在干活！" },
  waiting: { name: "等你", note: "晃脑袋，闪光一闪一闪", say: "等你确认一下" },
  success: { name: "完成", note: "跳起来，闪光炸开", say: "搞定啦！" },
  error: { name: "出错", note: "塌下来，冒一滴冷汗", say: "呜…出错了" },
};

export const PALETTES_INFO = {
  sky: { name: "天空", stops: ["#7cc6ff", "#3f84f8", "#4a36d8"], feet: "#4336cf" },
  grape: { name: "葡萄", stops: ["#ecd4ff", "#a670ff", "#5a2fd6"], feet: "#4824b4" },
  mint: { name: "薄荷", stops: ["#d2fff1", "#3fd2b2", "#14898d"], feet: "#0e7275" },
  peach: { name: "蜜桃", stops: ["#ffe6cc", "#ff9b72", "#e5506c"], feet: "#c33f58" },
  cloud: { name: "云朵", stops: ["#ffffff", "#f3f6ff", "#c8d3ff"], feet: "#b1bff9" },
} as const;
