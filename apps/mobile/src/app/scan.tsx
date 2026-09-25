import { CameraView, useCameraPermissions } from "expo-camera";
import { Stack, useRouter } from "expo-router";
import { useState } from "react";
import { Linking, Pressable, StyleSheet, Text, View } from "react-native";
import { ScanFrame } from "../ui/scan-frame";
import { setScannedAddress } from "../ui/scanned";
import { usePalette } from "../ui/theme";

export default function ScanScreen() {
  const palette = usePalette();
  const router = useRouter();
  const [permission, requestPermission] = useCameraPermissions();
  const [done, setDone] = useState(false);

  function scanned(data: string): void {
    if (done) return;
    setDone(true);
    setScannedAddress(data);
    router.back();
  }

  return (
    <View style={[styles.screen, { backgroundColor: palette.background }]}>
      <Stack.Screen options={{ title: "扫码" }} />
      {!permission ? (
        <Text style={[styles.note, { color: palette.muted }]}>正在请求相机权限</Text>
      ) : !permission.granted ? (
        <View style={styles.center}>
          <Text style={[styles.note, { color: palette.text }]}>需要相机才能扫描设置里的二维码。</Text>
          <Pressable onPress={() => void requestPermission()} style={[styles.button, { backgroundColor: palette.accent }]}>
            <Text style={{ color: palette.accentText, fontSize: 16 }}>允许使用相机</Text>
          </Pressable>
          <Pressable onPress={() => void Linking.openSettings()}>
            <Text style={{ color: palette.accent, fontSize: 15 }}>打开系统设置</Text>
          </Pressable>
        </View>
      ) : (
        <View style={styles.camera}>
          <CameraView
            style={StyleSheet.absoluteFill}
            facing="back"
            barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
            onBarcodeScanned={({ data }) => scanned(data)}
          />
          <ScanFrame accent={palette.accent} />
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  camera: { flex: 1, backgroundColor: "#000000" },
  center: { flex: 1, alignItems: "center", justifyContent: "center", gap: 16, padding: 28 },
  note: { fontSize: 15, lineHeight: 22, textAlign: "center" },
  button: { borderRadius: 12, paddingHorizontal: 16, paddingVertical: 12 },
});
