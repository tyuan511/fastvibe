import type { JSX } from "react";
import { Image, StyleSheet, Text, View } from "react-native";
import logo from "../../assets/icon.png";
import { DesktopSpinner } from "../chat/desktop-spinner";
import type { Palette } from "./theme";

export function BrandLogo({ size = 64 }: { size?: number }): JSX.Element {
  return <Image source={logo} style={{ width: size, height: size, borderRadius: size * 0.22 }} />;
}

export function BrandLoading({ palette, message }: { palette: Palette; message?: string }): JSX.Element {
  return (
    <View style={styles.loading}>
      <BrandLogo size={72} />
      <Text style={[styles.name, { color: palette.text }]}>FastVibe</Text>
      <View style={styles.status}>
        <DesktopSpinner color={palette.muted} size={14} />
        {message ? <Text style={[styles.message, { color: palette.muted }]}>{message}</Text> : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  loading: { alignItems: "center", justifyContent: "center", gap: 10, padding: 24 },
  name: { fontSize: 18, fontWeight: "700", letterSpacing: -0.3 },
  status: { flexDirection: "row", alignItems: "center", gap: 7, minHeight: 20 },
  message: { fontSize: 13 },
});
