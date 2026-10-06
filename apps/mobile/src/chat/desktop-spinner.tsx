import { useEffect, useRef, type JSX } from "react";
import { Animated, Easing } from "react-native";
import { HugeiconsIcon } from "@hugeicons/react-native";
import { Loading03Icon } from "../ui/icons";

/** RN version of the desktop Spinner: Hugeicons Loading03Icon, 0.7s linear spin. */
export function DesktopSpinner({ color, size = 16 }: { color: string; size?: number }): JSX.Element {
  const rotation = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    const animation = Animated.loop(
      Animated.timing(rotation, {
        toValue: 1,
        duration: 700,
        easing: Easing.linear,
        useNativeDriver: true,
      }),
    );
    animation.start();
    return () => animation.stop();
  }, [rotation]);

  const rotate = rotation.interpolate({ inputRange: [0, 1], outputRange: ["0deg", "360deg"] });
  return (
    <Animated.View style={{ width: size, height: size, transform: [{ rotate }] }}>
      <HugeiconsIcon icon={Loading03Icon} size={size} color={color} strokeWidth={2} />
    </Animated.View>
  );
}
