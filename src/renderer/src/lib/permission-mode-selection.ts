import type { PermissionMode } from "@shared/types";

export type PermissionModeSettings = {
  permissionMode: PermissionMode;
  defaultPermissionMode: PermissionMode;
  fullAccessConfirmed?: boolean;
};

/**
 * 完全访问 is a machine-wide choice. Once acknowledged, changing away and back does
 * not ask again; clearing all settings is the explicit way to forget the acknowledgement.
 */
export function needsFullAccessConfirmation(
  settings: PermissionModeSettings,
  mode: PermissionMode,
): boolean {
  return mode === "full" && !settings.fullAccessConfirmed;
}

/** Every picker changes the persisted startup mode as well as the live sandbox mode. */
export function permissionModePatch(
  mode: PermissionMode,
  confirmedFullAccess = false,
): PermissionModeSettings {
  return {
    permissionMode: mode,
    defaultPermissionMode: mode,
    ...(confirmedFullAccess ? { fullAccessConfirmed: true } : {}),
  };
}
