import type { PermissionMode } from "@shared/types";
import { i18n } from "@/lib/i18n";

/**
 * Display names for the composer's permission modes. Shared so 设置 → 通用 → 默认权限模式
 * and the composer's own menu cannot drift apart. Functions rather than records so
 * they never freeze a language (see `thinking-levels.ts`).
 */
export function permissionLabel(mode: PermissionMode): string {
  return i18n.t(`common:permission.${mode}`) as string;
}

/** One-line explanation of what each mode asks about; the composer's menu shows it. */
export function permissionDescription(mode: PermissionMode): string {
  return i18n.t(`common:permission.${mode}Desc`) as string;
}

/** Safest first, so every menu lists the modes in the same order. */
export const PERMISSION_MODES: readonly PermissionMode[] = ["ask", "smart", "full"];

/** `items` for the Select primitive (shadcn Nova takes a value → label map). */
export function permissionModeItems(): Record<string, string> {
  return Object.fromEntries(PERMISSION_MODES.map((mode) => [mode, permissionLabel(mode)]));
}

/** Narrow an untrusted persisted value (settings.json, an old build) to a mode. */
export function isPermissionMode(value: unknown): value is PermissionMode {
  return typeof value === "string" && (PERMISSION_MODES as readonly string[]).includes(value);
}
