import type { PermissionMode } from "@shared/types";

/**
 * Display names for the composer's permission modes. Shared so 设置 → 通用 → 默认权限模式
 * and the composer's own menu cannot drift apart.
 */
export const PERMISSION_LABELS: Record<PermissionMode, string> = {
  ask: "请求批准",
  smart: "帮我批准",
  full: "完全访问",
};

/** One-line explanation of what each mode asks about; the composer's menu shows it. */
export const PERMISSION_DESCRIPTIONS: Record<PermissionMode, string> = {
  ask: "编辑外部文件和使用互联网时始终询问",
  smart: "仅对检测到的风险操作请求批准",
  full: "可不受限制地访问互联网和你电脑上的任何文件",
};

/** Safest first, so every menu lists the modes in the same order. */
export const PERMISSION_MODES: readonly PermissionMode[] = ["ask", "smart", "full"];

/** `items` for the Select primitive (shadcn Nova takes a value → label map). */
export const PERMISSION_MODE_ITEMS: Record<string, string> = Object.fromEntries(
  PERMISSION_MODES.map((mode) => [mode, PERMISSION_LABELS[mode]]),
);

/** Narrow an untrusted persisted value (settings.json, an old build) to a mode. */
export function isPermissionMode(value: unknown): value is PermissionMode {
  return typeof value === "string" && (PERMISSION_MODES as readonly string[]).includes(value);
}
