import { CameraView, useCameraPermissions } from "expo-camera";
import { Stack, useRouter } from "expo-router";
import { useState } from "react";
import { Linking, Pressable, StyleSheet, Text, View } from "react-native";
import { HugeiconsIcon } from "@hugeicons/react-native";
import { ScanFrame } from "../ui/scan-frame";
import { QrCode01Icon } from "../ui/icons";
import { PrimaryButton } from "../ui/kit";
import { useT } from "../i18n";
import { setScannedAddress } from "../ui/scanned";
import { usePalette } from "../ui/theme";

export default function ScanScreen() {
  const palette = usePalette();
  const { t } = useT();
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
      <Stack.Screen options={{ title: t("nav.scan") }} />
      {!permission ? (
        <Text style={[styles.note, { color: palette.muted }]}>{t("scan.requesting")}</Text>
      ) : !permission.granted ? (
        <View style={styles.center}>
          <View style={[styles.icon, { backgroundColor: palette.accentSoft }]}>
            <HugeiconsIcon icon={QrCode01Icon} size={30} color={palette.accent} strokeWidth={1.8} />
          </View>
          <Text style={[styles.title, { color: palette.text }]}>{t("scan.needCamera")}</Text>
          <Text style={[styles.note, { color: palette.muted }]}>{t("scan.needCameraBody")}</Text>
          <PrimaryButton label={t("scan.allow")} palette={palette} onPress={() => void requestPermission()} style={styles.button} />
          <Pressable onPress={() => void Linking.openSettings()}>
            <Text style={{ color: palette.accent, fontSize: 15 }}>{t("scan.openSettings")}</Text>
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
  icon: { width: 64, height: 64, borderRadius: 20, alignItems: "center", justifyContent: "center" },
  title: { fontSize: 18, fontWeight: "700" },
  button: { alignSelf: "stretch", maxWidth: 320, width: "100%" },
});
