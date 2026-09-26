import { Stack, useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useEffect, useRef, useState, type JSX, type ReactNode } from "react";
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react-native";
import { parseServerAddress } from "../protocol/address";
import { connectSaved, currentConnection } from "../session/connection";
import { upsertServer, writeToken } from "../storage/servers";
import { RemoteClient } from "../protocol/client";
import { takeScannedAddress } from "../ui/scanned";
import { PrimaryButton } from "../ui/kit";
import { useT } from "../i18n";
import { haptic } from "../ui/haptics";
import {
  Alert02Icon,
  ArrowRight01Icon,
  CheckmarkCircle02Icon,
  Link01Icon,
  LockPasswordIcon,
  PencilEdit02Icon,
  QrCode01Icon,
} from "../ui/icons";
import { radius, usePalette, type Palette } from "../ui/theme";

export default function AddServerScreen() {
  const palette = usePalette();
  const { t } = useT();
  const router = useRouter();
  const { scan } = useLocalSearchParams<{ scan?: string }>();
  const [url, setUrl] = useState("");
  const [alias, setAlias] = useState("");
  const [aliasTouched, setAliasTouched] = useState(false);
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const passwordRef = useRef<TextInput>(null);
  const scanned = useRef(false);

  // 扫码添加 from the device list lands here and goes straight on to the camera.
  useEffect(() => {
    if (scan !== "1" || scanned.current) return;
    scanned.current = true;
    router.push("/scan");
  }, [scan, router]);

  useFocusEffect(
    useCallback(() => {
      const value = takeScannedAddress();
      if (!value) return;
      setUrl(value);
      setError(null);
      haptic.success();
      setTimeout(() => passwordRef.current?.focus(), 350);
    }, []),
  );

  const parsed = parseServerAddress(url);
  const shownAlias = aliasTouched ? alias : alias || parsed?.host || "";

  async function submit(): Promise<void> {
    const address = parseServerAddress(url);
    if (!address) {
      setError(t("add.badAddress"));
      return;
    }
    if (!password) {
      setError(t("add.needPassword"));
      return;
    }
    setBusy(true);
    setError(null);
    const name = (aliasTouched ? alias : shownAlias).trim() || address.host;
    try {
      const remote = new RemoteClient();
      const token = await remote.login(address.origin, password, `FastVibe ${name}`);
      const saved = await upsertServer({
        id: newId(),
        alias: name,
        origin: address.origin,
        host: address.host,
        kind: address.kind,
        createdAt: Date.now(),
      });
      await writeToken(saved.id, token);
      await connectSaved(saved);
      if (currentConnection().status !== "ready") {
        setError(currentConnection().error ?? t("add.savedNotConnected"));
        return;
      }
      haptic.success();
      router.replace(`/server/${saved.id}`);
    } catch (caught) {
      haptic.warning();
      setError(caught instanceof Error ? caught.message : t("add.loginFailed"));
    } finally {
      setBusy(false);
    }
  }


  return (
    <KeyboardAvoidingView style={{ flex: 1, backgroundColor: palette.background }} behavior={Platform.OS === "ios" ? "padding" : undefined} keyboardVerticalOffset={100}>
      <Stack.Screen options={{ title: t("nav.addDevice") }} />
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <Pressable
          onPress={() => {
            haptic.tap();
            router.push("/scan");
          }}
          style={({ pressed }) => [styles.scanCard, { backgroundColor: palette.card, opacity: pressed ? 0.85 : 1 }]}
        >
          <View style={[styles.scanIcon, { backgroundColor: palette.accent }]}>
            <HugeiconsIcon icon={QrCode01Icon} size={26} color={palette.accentText} strokeWidth={1.9} />
          </View>
          <View style={styles.scanText}>
            <Text style={[styles.scanTitle, { color: palette.text }]}>{t("add.scanTitle")}</Text>
            <Text style={[styles.scanBody, { color: palette.muted }]}>{t("add.scanBody")}</Text>
          </View>
          <HugeiconsIcon icon={ArrowRight01Icon} size={18} color={palette.subtle} strokeWidth={2} />
        </Pressable>

        <View style={styles.divider}>
          <View style={[styles.line, { backgroundColor: palette.border }]} />
          <Text style={[styles.dividerText, { color: palette.subtle }]}>{t("add.orManual")}</Text>
          <View style={[styles.line, { backgroundColor: palette.border }]} />
        </View>

        <View style={[styles.form, { backgroundColor: palette.card }]}>
          <Field label={t("add.address")} icon={Link01Icon} palette={palette}>
            <TextInput
              value={url}
              onChangeText={setUrl}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="url"
              returnKeyType="next"
              placeholder={t("add.addressPlaceholder")}
              placeholderTextColor={palette.subtle}
              style={[styles.input, { color: palette.text }]}
            />
          </Field>
          {parsed ? (
            <View style={[styles.parsed, { backgroundColor: parsed.kind === "loopback" ? palette.dangerSoft : palette.successSoft }]}>
              <HugeiconsIcon
                icon={parsed.kind === "loopback" ? Alert02Icon : CheckmarkCircle02Icon}
                size={15}
                color={parsed.kind === "loopback" ? palette.danger : palette.success}
                strokeWidth={2}
              />
              <Text style={[styles.parsedText, { color: parsed.kind === "loopback" ? palette.danger : palette.success }]}>
                {parsed.kind === "loopback"
                  ? t("add.loopbackWarning")
                  : parsed.origin}
              </Text>
            </View>
          ) : url.trim() ? (
            <View style={[styles.parsed, { backgroundColor: palette.dangerSoft }]}>
              <HugeiconsIcon icon={Alert02Icon} size={15} color={palette.danger} strokeWidth={2} />
              <Text style={[styles.parsedText, { color: palette.danger }]}>{t("add.unrecognized")}</Text>
            </View>
          ) : null}
          <View style={[styles.separator, { backgroundColor: palette.separator }]} />
          <Field label={t("add.alias")} icon={PencilEdit02Icon} palette={palette}>
            <TextInput
              value={shownAlias}
              onChangeText={(value) => {
                setAliasTouched(true);
                setAlias(value);
              }}
              returnKeyType="next"
              onSubmitEditing={() => passwordRef.current?.focus()}
              placeholder={t("add.aliasPlaceholder")}
              placeholderTextColor={palette.subtle}
              style={[styles.input, { color: palette.text }]}
            />
          </Field>
          <View style={[styles.separator, { backgroundColor: palette.separator }]} />
          <Field label={t("add.password")} icon={LockPasswordIcon} palette={palette}>
            <TextInput
              ref={passwordRef}
              value={password}
              onChangeText={setPassword}
              secureTextEntry
              returnKeyType="go"
              onSubmitEditing={() => void submit()}
              placeholder={t("add.passwordPlaceholder")}
              placeholderTextColor={palette.subtle}
              style={[styles.input, { color: palette.text }]}
            />
          </Field>
        </View>

        {error ? (
          <View style={[styles.error, { backgroundColor: palette.dangerSoft }]}>
            <HugeiconsIcon icon={Alert02Icon} size={16} color={palette.danger} strokeWidth={2} />
            <Text style={[styles.errorText, { color: palette.danger }]}>{error}</Text>
          </View>
        ) : null}

        <PrimaryButton label={t("add.submit")} palette={palette} busy={busy} disabled={!parsed || !password} onPress={() => void submit()} />

        <Text style={[styles.hint, { color: palette.muted }]}>
          {t("add.hint")}
        </Text>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

function newId(): string {
  return `srv-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function Field({
  label,
  icon,
  palette,
  children,
}: {
  label: string;
  icon: IconSvgElement;
  palette: Palette;
  children: ReactNode;
}): JSX.Element {
  return (
    <View style={styles.field}>
      <View style={styles.fieldLabel}>
        <HugeiconsIcon icon={icon} size={14} color={palette.muted} strokeWidth={2} />
        <Text style={[styles.label, { color: palette.muted }]}>{label}</Text>
      </View>
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  content: { padding: 16, gap: 14, paddingBottom: 40 },
  scanCard: { flexDirection: "row", alignItems: "center", gap: 14, padding: 16, borderRadius: radius.lg },
  scanIcon: { width: 50, height: 50, borderRadius: 15, alignItems: "center", justifyContent: "center" },
  scanText: { flex: 1, gap: 3 },
  scanTitle: { fontSize: 17, fontWeight: "700" },
  scanBody: { fontSize: 13, lineHeight: 18 },
  divider: { flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 8 },
  line: { flex: 1, height: StyleSheet.hairlineWidth },
  dividerText: { fontSize: 12, fontWeight: "600" },
  form: { borderRadius: radius.lg, paddingHorizontal: 16, paddingVertical: 6 },
  field: { paddingVertical: 8, gap: 2 },
  fieldLabel: { flexDirection: "row", alignItems: "center", gap: 5 },
  label: { fontSize: 12, fontWeight: "700", letterSpacing: 0.2 },
  input: { fontSize: 17, paddingVertical: 8, paddingHorizontal: 0 },
  separator: { height: StyleSheet.hairlineWidth },
  parsed: { flexDirection: "row", alignItems: "center", gap: 7, borderRadius: radius.sm, paddingHorizontal: 10, paddingVertical: 8, marginBottom: 8 },
  parsedText: { flex: 1, fontSize: 13, lineHeight: 18, fontWeight: "500" },
  error: { flexDirection: "row", alignItems: "flex-start", gap: 8, borderRadius: radius.md, padding: 12 },
  errorText: { flex: 1, fontSize: 14, lineHeight: 20 },
  hint: { fontSize: 13, lineHeight: 20, paddingHorizontal: 4 },
});
