import type { ThinkingLevel } from "@shared/types";
import { i18n } from "@/lib/i18n";

/**
 * Display names for the engine's thinking levels. Shared so the composer's effort
 * menu, 设置 → 对话 and 模型详情 cannot drift apart.
 *
 * `off` keeps a label but is never *offered* (see `THINKING_EFFORT_LEVELS`): a model
 * that cannot think, or a conversation restored at that level, still has to be named
 * in the composer chip.
 *
 * These are functions, not records: a record is built once at module load and would
 * freeze the language it was built in. Call them during render (any component that
 * renders them subscribes through `useTranslation`).
 */
export function thinkingLabel(level: ThinkingLevel): string {
  return i18n.t(`common:thinking.${level}`) as string;
}

export type ThinkingMenuLevel = Exclude<ThinkingLevel, "off"> | "auto";

/**
 * The entries of 默认推理强度: "let the model decide" plus the real efforts. There is
 * no 关闭推理 on purpose — asking an upstream to disable thinking is rejected by models
 * that reason by default, and 跟随模型默认 already means "leave the parameter alone".
 * Order is the menu's.
 */
export const THINKING_MENU_ORDER: readonly ThinkingMenuLevel[] = [
  "auto",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

export function thinkingMenuLabel(level: ThinkingMenuLevel): string {
  return i18n.t(`common:thinking.${level}`) as string;
}

/** `items` for the Select primitive (shadcn Nova takes a value → label map). */
export function thinkingMenuItems(): Record<string, string> {
  return Object.fromEntries(THINKING_MENU_ORDER.map((level) => [level, thinkingMenuLabel(level)]));
}
