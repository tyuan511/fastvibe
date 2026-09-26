import { Stack } from "expo-router";
import { useState, type JSX, type ReactNode } from "react";
import { ActivityIndicator, Linking, Pressable, ScrollView, StyleSheet, Switch, Text, View } from "react-native";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react-native";
import { OptionSheet } from "../chat/option-sheet";
import { setLanguagePreference, useLanguagePreference, useT, type LanguagePreference } from "../i18n";
import { BrandLogo } from "../ui/brand";
import { haptic } from "../ui/haptics";
import {
  ArrowRight01Icon,
  ArrowUp02Icon,
  Globe02Icon,
  InformationCircleIcon,
  Sun03Icon,
  TouchInteraction01Icon,
} from "../ui/icons";
import { setPreference, usePreferences, type ThemePreference } from "../ui/preferences";
import { elevation, radius, usePalette, type Palette } from "../ui/theme";
import { RELEASE_REPO } from "../update/release";
import { UpdateBanner, checkForUpdatesManually } from "../update/update-banner";
import { currentVersion, updatesSupported } from "../update/updater";

/** Language names are shown in their own language, whatever the interface is in. */
const LANGUAGE_NAMES: Record<Exclude<LanguagePreference, "system">, string> = { zh: "简体中文", en: "English" };

/**
 * Settings that belong to this phone. What the agent is allowed to do, which model it
 * runs and the like are the machine's settings and stay in the chat's composer; this
 * page is only the app itself — how it looks, what language it speaks, and which build
 * it is.
 */
export default function SettingsScreen() {
  const palette = usePalette();
  const { t } = useT();
  const preferences = usePreferences();
  const language = useLanguagePreference();
  const [pickingLanguage, setPickingLanguage] = useState(false);
  const [checking, setChecking] = useState(false);

  const themes: Array<{ value: ThemePreference; label: string }> = [
    { value: "system", label: t("settings.system") },
    { value: "light", label: t("settings.light") },
    { value: "dark", label: t("settings.dark") },
  ];

  async function check(): Promise<void> {
    setChecking(true);
    try {
      await checkForUpdatesManually();
    } finally {
      setChecking(false);
    }
  }

  return (
    <View style={[styles.screen, { backgroundColor: palette.background }]}>
      <Stack.Screen options={{ title: t("nav.settings") }} />
      <ScrollView contentContainerStyle={styles.content}>
        <Section title={t("settings.appearance")} palette={palette}>
          <View style={styles.block}>
            <RowHead icon={Sun03Icon} label={t("settings.theme")} palette={palette} />
            <View style={[styles.segmented, { backgroundColor: palette.field }]}>
              {themes.map((item) => {
                const active = preferences.theme === item.value;
                return (
                  <Pressable
                    key={item.value}
                    accessibilityRole="button"
                    accessibilityState={{ selected: active }}
                    onPress={() => {
                      haptic.select();
                      void setPreference("theme", item.value);
                    }}
                    style={[styles.segment, active ? [styles.segmentActive, elevation(palette), { backgroundColor: palette.card }] : null]}
                  >
                    <Text style={[styles.segmentLabel, { color: active ? palette.text : palette.muted }]}>{item.label}</Text>
                  </Pressable>
                );
              })}
            </View>
          </View>
          <Divider palette={palette} />
          <Row
            icon={Globe02Icon}
            label={t("settings.language")}
            value={language === "system" ? t("settings.system") : LANGUAGE_NAMES[language]}
            palette={palette}
            onPress={() => setPickingLanguage(true)}
          />
        </Section>

        <Section title={t("settings.general")} palette={palette}>
          <Row
            icon={TouchInteraction01Icon}
            label={t("settings.haptics")}
            description={t("settings.hapticsHint")}
            palette={palette}
            right={
              <Switch
                value={preferences.haptics}
                onValueChange={(value) => {
                  void setPreference("haptics", value);
                  if (value) haptic.success();
                }}
                trackColor={{ true: palette.accent, false: palette.field }}
              />
            }
          />
        </Section>

        <Section title={t("settings.about")} palette={palette}>
          <View style={styles.about}>
            <BrandLogo size={52} />
            <View style={styles.aboutText}>
              <Text style={[styles.appName, { color: palette.text }]}>FastVibe</Text>
              <Text style={[styles.appVersion, { color: palette.muted }]}>{t("settings.versionValue", { version: currentVersion() })}</Text>
            </View>
          </View>
          {updatesSupported ? (
            <>
              <Divider palette={palette} />
              <Row
                icon={ArrowUp02Icon}
                label={t("update.check")}
                palette={palette}
                onPress={checking ? undefined : () => void check()}
                right={checking ? <ActivityIndicator size="small" color={palette.muted} /> : undefined}
              />
            </>
          ) : null}
          <Divider palette={palette} />
          <Row
            icon={InformationCircleIcon}
            label={t("settings.releaseNotes")}
            palette={palette}
            onPress={() => void Linking.openURL(`https://github.com/${RELEASE_REPO}/releases`)}
          />
        </Section>
        {updatesSupported ? <UpdateBanner palette={palette} /> : null}
      </ScrollView>
      <OptionSheet
        open={pickingLanguage}
        title={t("settings.language")}
        subtitle={t("settings.languageHint")}
        groups={[{
          label: "",
          options: [
            { value: "system", label: t("settings.system"), icon: Globe02Icon },
            { value: "zh", label: LANGUAGE_NAMES.zh },
            { value: "en", label: LANGUAGE_NAMES.en },
          ],
        }]}
        value={language}
        onSelect={(value) => void setLanguagePreference(value as LanguagePreference)}
        onClose={() => setPickingLanguage(false)}
      />
    </View>
  );
}

function Section({ title, palette, children }: { title: string; palette: Palette; children: ReactNode }): JSX.Element {
  return (
    <View style={styles.section}>
      <Text style={[styles.sectionTitle, { color: palette.muted }]}>{title}</Text>
      <View style={[styles.card, { backgroundColor: palette.card }]}>{children}</View>
    </View>
  );
}

function RowHead({ icon, label, palette }: { icon: IconSvgElement; label: string; palette: Palette }): JSX.Element {
  return (
    <View style={styles.rowHead}>
      <View style={[styles.rowIcon, { backgroundColor: palette.accentSoft }]}>
        <HugeiconsIcon icon={icon} size={17} color={palette.accent} strokeWidth={2} />
      </View>
      <Text style={[styles.rowLabel, { color: palette.text }]}>{label}</Text>
    </View>
  );
}

function Row({
  icon,
  label,
  description,
  value,
  right,
  palette,
  onPress,
}: {
  icon: IconSvgElement;
  label: string;
  description?: string;
  value?: string;
  right?: ReactNode;
  palette: Palette;
  onPress?: () => void;
}): JSX.Element {
  return (
    <Pressable
      disabled={!onPress}
      onPress={() => {
        haptic.tap();
        onPress?.();
      }}
      style={({ pressed }) => [styles.row, pressed && onPress ? { backgroundColor: palette.field } : null]}
    >
      <View style={[styles.rowIcon, { backgroundColor: palette.accentSoft }]}>
        <HugeiconsIcon icon={icon} size={17} color={palette.accent} strokeWidth={2} />
      </View>
      <View style={styles.rowText}>
        <Text style={[styles.rowLabel, { color: palette.text }]}>{label}</Text>
        {description ? <Text style={[styles.rowDescription, { color: palette.muted }]}>{description}</Text> : null}
      </View>
      {value ? <Text style={[styles.rowValue, { color: palette.muted }]} numberOfLines={1}>{value}</Text> : null}
      {right ?? (onPress ? <HugeiconsIcon icon={ArrowRight01Icon} size={16} color={palette.subtle} strokeWidth={2} /> : null)}
    </Pressable>
  );
}

function Divider({ palette }: { palette: Palette }): JSX.Element {
  return <View style={[styles.divider, { backgroundColor: palette.separator }]} />;
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  content: { padding: 16, paddingBottom: 40, gap: 6 },
  section: { gap: 8, marginBottom: 14 },
  sectionTitle: { fontSize: 13, fontWeight: "700", paddingHorizontal: 6 },
  card: { borderRadius: radius.lg, overflow: "hidden" },
  block: { padding: 14, gap: 12 },
  rowHead: { flexDirection: "row", alignItems: "center", gap: 12 },
  row: { flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 14, paddingVertical: 12, minHeight: 54 },
  rowIcon: { width: 30, height: 30, borderRadius: 9, alignItems: "center", justifyContent: "center" },
  rowText: { flex: 1, minWidth: 0, gap: 2 },
  rowLabel: { fontSize: 16, fontWeight: "500" },
  rowDescription: { fontSize: 13, lineHeight: 18 },
  rowValue: { fontSize: 15, maxWidth: 160 },
  divider: { height: StyleSheet.hairlineWidth, marginLeft: 56 },
  segmented: { flexDirection: "row", borderRadius: radius.md, padding: 3 },
  segment: { flex: 1, height: 34, alignItems: "center", justifyContent: "center", borderRadius: 9 },
  segmentActive: {},
  segmentLabel: { fontSize: 14, fontWeight: "600" },
  about: { flexDirection: "row", alignItems: "center", gap: 14, padding: 14 },
  aboutText: { gap: 2 },
  appName: { fontSize: 18, fontWeight: "800", letterSpacing: -0.3 },
  appVersion: { fontSize: 13, fontVariant: ["tabular-nums"] },
});
