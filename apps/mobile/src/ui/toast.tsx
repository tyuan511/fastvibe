import { useEffect, useRef, useState, useSyncExternalStore, type JSX } from "react";
import { Animated, Easing, Pressable, StyleSheet, Text, View } from "react-native";
import { HugeiconsIcon } from "@hugeicons/react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Alert02Icon, CheckmarkCircle02Icon, InformationCircleIcon } from "./icons";
import { haptic } from "./haptics";
import { elevation, radius, usePalette } from "./theme";

/**
 * The one way the app says an action worked or failed: 已复制, 已归档, 重命名失败…
 *
 * One toast at a time — a newer one replaces the one on screen rather than stacking,
 * because feedback about the previous tap is stale the moment the next tap lands.
 * The store owns the timing; `ToastHost` only draws it, so a host can be mounted in
 * more than one place (see there) without two timers disagreeing.
 */
type Kind = "success" | "error" | "info";
type Item = { id: number; kind: Kind; message: string };

let current: Item | null = null;
let nextId = 1;
let timer: ReturnType<typeof setTimeout> | null = null;
const listeners = new Set<() => void>();

function show(kind: Kind, message: string): void {
  if (!message) return;
  current = { id: nextId++, kind, message };
  if (kind === "success") haptic.success();
  else if (kind === "error") haptic.warning();
  if (timer) clearTimeout(timer);
  timer = setTimeout(dismiss, kind === "error" ? 4000 : 2200);
  for (const listener of listeners) listener();
}

function dismiss(): void {
  if (timer) clearTimeout(timer);
  timer = null;
  current = null;
  for (const listener of listeners) listener();
}

export const toast = {
  success: (message: string) => show("success", message),
  error: (message: string) => show("error", message),
  info: (message: string) => show("info", message),
  /** An error's own message where it has one, the fallback otherwise. */
  failure: (error: unknown, fallback: string) =>
    show("error", error instanceof Error && error.message ? error.message : fallback),
};

/**
 * Draws the current toast at the top of the screen.
 *
 * Mounted in the root layout *and* inside every modal (the sheet, the dialog): a modal
 * is its own native window, so a toast drawn only by the root would sit hidden behind
 * an open sheet. Whichever copy is on top is the one seen; the others are covered.
 */
export function ToastHost(): JSX.Element | null {
  const palette = usePalette();
  const insets = useSafeAreaInsets();
  const item = useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => current,
    () => current,
  );
  const [shown, setShown] = useState<Item | null>(item);
  const progress = useRef(new Animated.Value(item ? 1 : 0)).current;

  useEffect(() => {
    if (item) {
      setShown(item);
      progress.setValue(0);
      Animated.spring(progress, { toValue: 1, useNativeDriver: true, speed: 18, bounciness: 6 }).start();
    } else {
      Animated.timing(progress, { toValue: 0, duration: 180, easing: Easing.in(Easing.quad), useNativeDriver: true }).start(({ finished }) => {
        if (finished) setShown(null);
      });
    }
  }, [item, progress]);

  if (!shown) return null;
  const tone =
    shown.kind === "success"
      ? { icon: CheckmarkCircle02Icon, color: palette.success, soft: palette.successSoft }
      : shown.kind === "error"
        ? { icon: Alert02Icon, color: palette.danger, soft: palette.dangerSoft }
        : { icon: InformationCircleIcon, color: palette.accent, soft: palette.accentSoft };

  return (
    <View pointerEvents="box-none" style={[styles.layer, { top: insets.top + 8 }]}>
      <Animated.View
        style={{
          opacity: progress,
          transform: [{ translateY: progress.interpolate({ inputRange: [0, 1], outputRange: [-24, 0] }) }],
        }}
      >
        <Pressable
          onPress={dismiss}
          accessibilityRole="alert"
          style={[styles.toast, elevation(palette, 2), { backgroundColor: palette.card, borderColor: palette.border }]}
        >
          <View style={[styles.icon, { backgroundColor: tone.soft }]}>
            <HugeiconsIcon icon={tone.icon} size={15} color={tone.color} strokeWidth={2.2} />
          </View>
          <Text style={[styles.message, { color: palette.text }]} numberOfLines={3}>
            {shown.message}
          </Text>
        </Pressable>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  layer: { position: "absolute", left: 16, right: 16, alignItems: "center", zIndex: 1000, elevation: 1000 },
  toast: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    maxWidth: 440,
    borderRadius: radius.pill,
    borderWidth: StyleSheet.hairlineWidth,
    paddingLeft: 8,
    paddingRight: 16,
    paddingVertical: 8,
  },
  icon: { width: 26, height: 26, borderRadius: 13, alignItems: "center", justifyContent: "center" },
  message: { flexShrink: 1, fontSize: 14, fontWeight: "600", lineHeight: 19 },
});
