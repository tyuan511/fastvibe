import { useEffect, useRef, type JSX } from "react";
import { useT } from "../i18n";
import { Animated, Easing, StyleSheet, Text, View, useWindowDimensions } from "react-native";

/** Fixed rather than themed: this sits on a camera feed, which is neither light nor dark. */
const MASK = "rgba(0, 0, 0, 0.55)";
const CORNER = "#ffffff";
const CORNER_LENGTH = 28;
const CORNER_WIDTH = 4;
const LINE_INSET = 12;

/**
 * The viewfinder drawn over the camera: the feed dimmed except for a square in the
 * middle, corner marks on that square and a line sweeping through it, plus a hint.
 *
 * Guidance only — the scanner still reads a code anywhere in the frame. Restricting it
 * to the square would make a code held slightly off-centre fail for no reason the user
 * can see; the square is there so they know where to aim, not to refuse what they did.
 */
export function ScanFrame({ accent }: { accent: string }): JSX.Element {
  const { t } = useT();
  const { width } = useWindowDimensions();
  const size = Math.min(width * 0.68, 280);
  const sweep = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    const animation = Animated.loop(
      Animated.sequence([
        Animated.timing(sweep, { toValue: 1, duration: 1800, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
        Animated.timing(sweep, { toValue: 0, duration: 1800, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
      ]),
    );
    animation.start();
    return () => animation.stop();
  }, [sweep]);

  const translateY = sweep.interpolate({ inputRange: [0, 1], outputRange: [LINE_INSET, size - LINE_INSET] });

  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="none">
      <View style={[styles.mask, styles.grow]} />
      <View style={{ flexDirection: "row", height: size }}>
        <View style={[styles.mask, styles.grow]} />
        <View style={{ width: size, height: size }}>
          <View style={[styles.corner, styles.topLeft]} />
          <View style={[styles.corner, styles.topRight]} />
          <View style={[styles.corner, styles.bottomLeft]} />
          <View style={[styles.corner, styles.bottomRight]} />
          <Animated.View style={[styles.line, { backgroundColor: accent, transform: [{ translateY }] }]} />
        </View>
        <View style={[styles.mask, styles.grow]} />
      </View>
      <View style={[styles.mask, styles.grow, styles.below]}>
        <Text style={styles.hint}>{t("scan.aim")}</Text>
        <Text style={styles.detail}>{t("scan.where")}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  grow: { flex: 1 },
  mask: { backgroundColor: MASK },
  below: { alignItems: "center", paddingTop: 28, paddingHorizontal: 32, gap: 6 },
  hint: { color: "#ffffff", fontSize: 16, fontWeight: "600" },
  detail: { color: "rgba(255, 255, 255, 0.75)", fontSize: 13, lineHeight: 19, textAlign: "center" },
  corner: { position: "absolute", width: CORNER_LENGTH, height: CORNER_LENGTH, borderColor: CORNER },
  topLeft: { top: 0, left: 0, borderTopWidth: CORNER_WIDTH, borderLeftWidth: CORNER_WIDTH, borderTopLeftRadius: 6 },
  topRight: { top: 0, right: 0, borderTopWidth: CORNER_WIDTH, borderRightWidth: CORNER_WIDTH, borderTopRightRadius: 6 },
  bottomLeft: { bottom: 0, left: 0, borderBottomWidth: CORNER_WIDTH, borderLeftWidth: CORNER_WIDTH, borderBottomLeftRadius: 6 },
  bottomRight: { bottom: 0, right: 0, borderBottomWidth: CORNER_WIDTH, borderRightWidth: CORNER_WIDTH, borderBottomRightRadius: 6 },
  line: { position: "absolute", left: LINE_INSET, right: LINE_INSET, top: 0, height: 2, borderRadius: 1, opacity: 0.9 },
});
