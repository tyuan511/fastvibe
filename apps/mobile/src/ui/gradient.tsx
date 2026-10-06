import { useId, useState, type JSX, type ReactNode } from "react";
import { StyleSheet, View, type StyleProp, type ViewStyle } from "react-native";
import Svg, { Defs, LinearGradient, Rect, Stop } from "react-native-svg";

/**
 * A diagonal two-stop gradient behind its children — the app icon's blue → indigo.
 *
 * Drawn with react-native-svg (already linked for the icons) rather than a gradient
 * module of its own, so it adds nothing to the APK.
 */
export function Gradient({
  colors,
  style,
  children,
  radius = 0,
}: {
  colors: [string, string];
  style?: StyleProp<ViewStyle>;
  children?: ReactNode;
  radius?: number;
}): JSX.Element {
  const id = `g${useId().replace(/[^a-zA-Z0-9]/g, "")}`;
  // Sized from the box's own layout: a percentage-sized Svg resolved against its first
  // measurement and stayed there, leaving the gradient short of the card it fills.
  const [size, setSize] = useState({ width: 0, height: 0 });
  return (
    <View
      style={[{ borderRadius: radius, overflow: "hidden" }, style]}
      onLayout={(event) => {
        const { width, height } = event.nativeEvent.layout;
        if (width !== size.width || height !== size.height) setSize({ width, height });
      }}
    >
      <Svg style={StyleSheet.absoluteFill} width={size.width} height={size.height}>
        <Defs>
          <LinearGradient id={id} x1="0" y1="0" x2="1" y2="1">
            <Stop offset="0" stopColor={colors[0]} />
            <Stop offset="1" stopColor={colors[1]} />
          </LinearGradient>
        </Defs>
        <Rect x="0" y="0" width={size.width} height={size.height} fill={`url(#${id})`} />
      </Svg>
      {children}
    </View>
  );
}
