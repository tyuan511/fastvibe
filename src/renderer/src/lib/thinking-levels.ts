import type { ThinkingLevel } from "@shared/types";

/**
 * Display names for the engine's thinking levels. Shared so the composer's effort
 * menu, 设置 → 对话 and 模型详情 cannot drift apart.
 */
export const THINKING_LABELS: Record<ThinkingLevel, string> = {
  off: "关闭推理",
  minimal: "极低",
  low: "低",
  medium: "中",
  high: "高",
  xhigh: "极高",
  max: "最高",
};

/** The same list plus the "let the model decide" option used for app defaults. */
export const THINKING_MENU_LABELS: Record<ThinkingLevel | "auto", string> = {
  auto: "跟随模型默认",
  ...THINKING_LABELS,
};
