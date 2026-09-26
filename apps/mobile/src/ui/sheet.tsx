import { useEffect, useRef, useState, type JSX, type ReactNode } from "react";
import {
  Animated,
  Easing,
  KeyboardAvoidingView,
  Modal,
  PanResponder,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { radius, usePalette } from "./theme";
import { t } from "../i18n";
import { sheetOpened } from "./overlay";
import { ToastHost } from "./toast";

/**
 * The one bottom sheet every picker and menu is drawn in.
 *
 * The backdrop fades while the panel slides — `Modal`'s own `slide` moved the dimmed
 * backdrop up with the panel, which read as a page sliding in rather than a sheet. The
 * header is a drag handle: pulled down past a third of the panel (or flicked), it
 * closes. `tall` fixes the height instead of fitting the content, for a sheet whose
 * content is filtered as the user types — a panel that shrinks under the finger on
 * every keystroke is impossible to aim at.
 */
export function Sheet({
  open,
  onClose,
  title,
  subtitle,
  headerRight,
  tall = false,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title?: string;
  subtitle?: string;
  headerRight?: ReactNode;
  tall?: boolean;
  children: ReactNode;
}): JSX.Element | null {
  const palette = usePalette();
  const insets = useSafeAreaInsets();
  const { height } = useWindowDimensions();
  const [mounted, setMounted] = useState(open);
  const progress = useRef(new Animated.Value(0)).current;
  const drag = useRef(new Animated.Value(0)).current;
  const panelHeight = useRef(0);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    if (open) {
      setMounted(true);
      drag.setValue(0);
      Animated.timing(progress, {
        toValue: 1,
        duration: 260,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }).start();
    } else if (mounted) {
      Animated.timing(progress, {
        toValue: 0,
        duration: 200,
        easing: Easing.in(Easing.cubic),
        useNativeDriver: true,
      }).start(({ finished }) => {
        if (finished) setMounted(false);
      });
    }
  }, [open, mounted, progress, drag]);

  // Counted while on screen, closing included, so a dialog waits for it (`overlay.ts`).
  useEffect(() => (mounted ? sheetOpened() : undefined), [mounted]);

  const pan = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponder: (_, gesture) => gesture.dy > 6 && Math.abs(gesture.dy) > Math.abs(gesture.dx),
      onPanResponderMove: (_, gesture) => drag.setValue(Math.max(0, gesture.dy)),
      onPanResponderRelease: (_, gesture) => {
        if (gesture.dy > panelHeight.current / 3 || gesture.vy > 1.2) {
          closeRef.current();
          return;
        }
        Animated.spring(drag, { toValue: 0, useNativeDriver: true, bounciness: 4 }).start();
      },
      onPanResponderTerminate: () => {
        Animated.spring(drag, { toValue: 0, useNativeDriver: true, bounciness: 4 }).start();
      },
    }),
  ).current;

  if (!mounted) return null;

  const translateY = Animated.add(
    progress.interpolate({ inputRange: [0, 1], outputRange: [height, 0] }),
    drag,
  );

  return (
    <Modal transparent visible animationType="none" onRequestClose={onClose} statusBarTranslucent>
      <Animated.View style={[StyleSheet.absoluteFill, { backgroundColor: palette.overlay, opacity: progress }]}>
        <Pressable style={StyleSheet.absoluteFill} onPress={onClose} accessibilityLabel={t("common.close")} />
      </Animated.View>
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        style={styles.anchor}
        pointerEvents="box-none"
      >
        <Animated.View
          onLayout={(event) => {
            panelHeight.current = event.nativeEvent.layout.height;
          }}
          style={[
            styles.panel,
            {
              backgroundColor: palette.card,
              paddingBottom: insets.bottom + 8,
              maxHeight: height - insets.top - 24,
              transform: [{ translateY }],
            },
            tall ? { height: Math.min(height * 0.86, height - insets.top - 24) } : null,
          ]}
        >
          <View {...pan.panHandlers} style={styles.header}>
            <View style={[styles.grabber, { backgroundColor: palette.border }]} />
            {title || headerRight ? (
              <View style={styles.titleRow}>
                <View style={styles.titleText}>
                  {title ? <Text style={[styles.title, { color: palette.text }]} numberOfLines={1}>{title}</Text> : null}
                  {subtitle ? <Text style={[styles.subtitle, { color: palette.muted }]} numberOfLines={1}>{subtitle}</Text> : null}
                </View>
                {headerRight}
              </View>
            ) : null}
          </View>
          {children}
        </Animated.View>
      </KeyboardAvoidingView>
      <ToastHost />
    </Modal>
  );
}

const styles = StyleSheet.create({
  anchor: { flex: 1, justifyContent: "flex-end" },
  panel: {
    borderTopLeftRadius: radius.xl,
    borderTopRightRadius: radius.xl,
    overflow: "hidden",
  },
  header: { paddingTop: 8, paddingHorizontal: 20, paddingBottom: 6 },
  grabber: { alignSelf: "center", width: 38, height: 5, borderRadius: 3, marginBottom: 10 },
  titleRow: { flexDirection: "row", alignItems: "center", gap: 12, minHeight: 32 },
  titleText: { flex: 1, minWidth: 0, gap: 1 },
  title: { fontSize: 18, fontWeight: "700", letterSpacing: -0.3 },
  subtitle: { fontSize: 13 },
});
