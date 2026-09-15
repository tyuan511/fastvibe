import type { ThinkingLevel } from "@shared/types";

/**
 * Display names for the engine's thinking levels. Shared so the composer's effort
 * menu, 设置 → 对话 and 模型详情 cannot drift apart.
 *
 * `off` keeps a label but is never *offered* (see `THINKING_EFFORT_LEVELS`): a model
 * that cannot think, or a conversation restored at that level, still has to be named
 * in the composer chip.
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

/**
 * The entries of 默认推理强度: "let the model decide" plus the real efforts. There is
 * no 关闭推理 on purpose — asking an upstream to disable thinking is rejected by models
 * that reason by default, and 跟随模型默认 already means "leave the parameter alone".
 */
export const THINKING_MENU_LABELS: Record<Exclude<ThinkingLevel, "off"> | "auto", string> = {
  auto: "跟随模型默认",
  minimal: THINKING_LABELS.minimal,
  low: THINKING_LABELS.low,
  medium: THINKING_LABELS.medium,
  high: THINKING_LABELS.high,
  xhigh: THINKING_LABELS.xhigh,
  max: THINKING_LABELS.max,
};
