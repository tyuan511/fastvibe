import * as Haptics from "expo-haptics";
import { currentPreferences } from "./preferences";

/**
 * Fire-and-forget haptics. A device with the feature off, or a runtime without the
 * module, rejects — and a tap must never fail because it could not buzz. 设置 → 触感反馈
 * turns them all off at once.
 */
export const haptic = {
  tap(): void {
    if (currentPreferences().haptics) void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => undefined);
  },
  select(): void {
    if (currentPreferences().haptics) void Haptics.selectionAsync().catch(() => undefined);
  },
  press(): void {
    if (currentPreferences().haptics) void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => undefined);
  },
  success(): void {
    if (currentPreferences().haptics) void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => undefined);
  },
  warning(): void {
    if (currentPreferences().haptics) void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning).catch(() => undefined);
  },
};
