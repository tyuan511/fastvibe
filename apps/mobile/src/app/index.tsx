import { Stack, useFocusEffect, useRouter } from "expo-router";
import { useCallback, useState, type JSX } from "react";
import { FlatList, Pressable, StyleSheet, Text, View } from "react-native";
import * as Clipboard from "expo-clipboard";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react-native";
import { loadServers, patchServer, removeServer, type SavedServer } from "../storage/servers";
import { useConnection } from "../session/connection";
import { dialog } from "../ui/dialog";
import { toast } from "../ui/toast";
import { OptionSheet } from "../chat/option-sheet";
import { BrandLogo } from "../ui/brand";
import { Gradient } from "../ui/gradient";
import { IconButton, SectionLabel } from "../ui/kit";
import { haptic } from "../ui/haptics";
import { relativeTime } from "../ui/time";
import {
  ComputerIcon,
  Copy01Icon,
  Delete02Icon,
  Link01Icon,
  PencilEdit02Icon,
  QrCode01Icon,
  Settings02Icon,
} from "../ui/icons";
import { radius, usePalette, type Palette } from "../ui/theme";
import { useT } from "../i18n";

export default function DevicesScreen() {
  const palette = usePalette();
  const { t } = useT();
  const router = useRouter();
  const connection = useConnection();
  const [servers, setServers] = useState<SavedServer[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [menu, setMenu] = useState<SavedServer | null>(null);

  const reload = useCallback(() => {
    void loadServers()
      .then((list) => setServers(list))
      .catch((error) => toast.failure(error, t("devices.loadFailed")))
      .finally(() => setLoaded(true));
  }, [t]);
  useFocusEffect(reload);

  function remove(server: SavedServer): void {
    dialog.confirm({
      title: t("devices.deleteTitle"),
      message: t("devices.deleteBody", { name: server.alias }),
      confirmLabel: t("common.delete"),
      destructive: true,
      onConfirm: () => {
        void removeServer(server.id)
          .then((list) => {
            setServers(list);
            toast.success(t("toast.deviceDeleted"));
          })
          .catch((error) => toast.failure(error, t("common.operationFailed")));
      },
    });
  }

  function handleMenu(action: string): void {
    const server = menu;
    setMenu(null);
    if (!server) return;
    if (action === "rename") {
      dialog.prompt({
        title: t("devices.alias"),
        initial: server.alias,
        onSubmit: async (value) => {
          const next = value.trim();
          if (!next || next === server.alias) return;
          setServers(await patchServer(server.id, { alias: next }));
          toast.success(t("toast.renamed"));
        },
      });
    } else if (action === "copy") {
      void Clipboard.setStringAsync(server.origin).then(() => toast.success(t("toast.addressCopied")));
    } else if (action === "delete") {
      remove(server);
    }
  }

  const hero = (
    <Gradient colors={palette.brand} radius={radius.xl} style={styles.hero}>
      <View style={styles.heroTop}>
        <View style={styles.heroLogo}>
          <BrandLogo size={46} />
        </View>
        <View style={styles.heroText}>
          <Text style={styles.heroTitle}>{t("devices.heroTitle")}</Text>
          <Text style={styles.heroBody}>{t("devices.heroBody")}</Text>
        </View>
      </View>
      <View style={styles.heroActions}>
        <HeroButton icon={QrCode01Icon} label={t("devices.scanAdd")} onPress={() => router.push("/add?scan=1")} />
        <HeroButton icon={Link01Icon} label={t("devices.enterAddress")} onPress={() => router.push("/add")} />
      </View>
    </Gradient>
  );

  return (
    <View style={[styles.screen, { backgroundColor: palette.background }]}>
      <Stack.Screen
        options={{
          title: "FastVibe",
          // Adding a device lives in the hero card's two buttons; the corner is settings.
          headerRight: () => (
            <IconButton icon={Settings02Icon} label={t("nav.settings")} tone="field" size={34} palette={palette} onPress={() => router.push("/settings")} />
          ),
        }}
      />
      <FlatList
        data={servers}
        keyExtractor={(item) => item.id}
        contentContainerStyle={styles.list}
        ListHeaderComponent={
          <View style={styles.header}>
            {loaded ? hero : null}
            {servers.length > 0 ? <SectionLabel title={t("devices.mine")} count={servers.length} palette={palette} /> : null}
          </View>
        }
        ListEmptyComponent={
          loaded ? (
            <View style={styles.steps}>
              <Step palette={palette} index={1} title={t("devices.step1Title")} body={t("devices.step1Body")} />
              <Step palette={palette} index={2} title={t("devices.step2Title")} body={t("devices.step2Body")} />
              <Step palette={palette} index={3} title={t("devices.step3Title")} body={t("devices.step3Body")} />
            </View>
          ) : null
        }
        ItemSeparatorComponent={() => <View style={styles.gap} />}
        renderItem={({ item }) => (
          <DeviceRow
            server={item}
            palette={palette}
            live={connection.server?.id === item.id && connection.status === "ready"}
            onPress={() => {
              haptic.tap();
              router.push(`/server/${item.id}`);
            }}
            onMenu={() => {
              haptic.tap();
              setMenu(item);
            }}
          />
        )}
      />
      <OptionSheet
        open={menu !== null}
        title={menu?.alias ?? t("common.device")}
        subtitle={menu?.host}
        groups={[{
          label: "",
          options: [
            { value: "rename", label: t("common.rename"), icon: PencilEdit02Icon },
            { value: "copy", label: t("devices.copyAddress"), icon: Copy01Icon },
            { value: "delete", label: t("devices.deleteDevice"), icon: Delete02Icon, destructive: true },
          ],
        }]}
        value={null}
        onSelect={handleMenu}
        onClose={() => setMenu(null)}
      />
    </View>
  );
}

function HeroButton({ icon, label, onPress }: { icon: IconSvgElement; label: string; onPress: () => void }): JSX.Element {
  return (
    <Pressable
      onPress={() => {
        haptic.tap();
        onPress();
      }}
      style={({ pressed }) => [styles.heroButton, { opacity: pressed ? 0.75 : 1 }]}
    >
      <HugeiconsIcon icon={icon} size={17} color="#ffffff" strokeWidth={2} />
      <Text style={styles.heroButtonLabel}>{label}</Text>
    </Pressable>
  );
}

function DeviceRow({
  server,
  palette,
  live,
  onPress,
  onMenu,
}: {
  server: SavedServer;
  palette: Palette;
  live: boolean;
  onPress: () => void;
  onMenu: () => void;
}): JSX.Element {
  const { t } = useT();
  const seen = server.lastConnectedAt ? t("devices.connectedAgo", { when: relativeTime(server.lastConnectedAt) }) : t("devices.neverConnected");
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${server.alias}, ${server.host}`}
      accessibilityHint={t("devices.openHint")}
      onPress={onPress}
      onLongPress={onMenu}
      delayLongPress={320}
      style={({ pressed }) => [styles.row, { backgroundColor: palette.card, opacity: pressed ? 0.85 : 1 }]}
    >
      <View style={[styles.rowIcon, { backgroundColor: palette.accentSoft }]}>
        <HugeiconsIcon icon={ComputerIcon} size={22} color={palette.accent} strokeWidth={1.9} />
        {live ? <View style={[styles.liveDot, { backgroundColor: palette.success, borderColor: palette.card }]} /> : null}
      </View>
      <View style={styles.rowText}>
        <Text style={[styles.alias, { color: palette.text }]} numberOfLines={1}>{server.alias}</Text>
        <Text style={[styles.host, { color: palette.muted }]} numberOfLines={1}>{server.host}</Text>
        <Text style={[styles.meta, { color: live ? palette.success : palette.subtle }]} numberOfLines={1}>
          {live ? t("devices.connected") : seen}
        </Text>
      </View>
    </Pressable>
  );
}

function Step({ palette, index, title, body }: { palette: Palette; index: number; title: string; body: string }): JSX.Element {
  return (
    <View style={[styles.step, { backgroundColor: palette.card }]}>
      <View style={[styles.stepIndex, { backgroundColor: palette.accentSoft }]}>
        <Text style={[styles.stepIndexText, { color: palette.accent }]}>{index}</Text>
      </View>
      <View style={styles.stepText}>
        <Text style={[styles.stepTitle, { color: palette.text }]}>{title}</Text>
        <Text style={[styles.stepBody, { color: palette.muted }]}>{body}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  list: { paddingHorizontal: 16, paddingBottom: 32 },
  header: { gap: 12, paddingTop: 4 },
  gap: { height: 10 },
  hero: { padding: 18, gap: 16 },
  heroTop: { flexDirection: "row", alignItems: "center", gap: 14 },
  heroLogo: { borderRadius: 14, borderWidth: 2, borderColor: "rgba(255,255,255,0.35)" },
  heroText: { flex: 1, gap: 4 },
  heroTitle: { color: "#ffffff", fontSize: 19, fontWeight: "800", letterSpacing: -0.3 },
  heroBody: { color: "rgba(255,255,255,0.85)", fontSize: 13, lineHeight: 19 },
  heroActions: { flexDirection: "row", gap: 10 },
  heroButton: {
    flex: 1,
    height: 42,
    borderRadius: radius.md,
    backgroundColor: "rgba(255,255,255,0.18)",
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "rgba(255,255,255,0.4)",
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 7,
  },
  heroButtonLabel: { color: "#ffffff", fontSize: 15, fontWeight: "700" },
  row: { borderRadius: radius.lg, padding: 14, flexDirection: "row", alignItems: "center", gap: 12 },
  rowIcon: { width: 46, height: 46, borderRadius: 14, alignItems: "center", justifyContent: "center" },
  liveDot: { position: "absolute", right: -2, bottom: -2, width: 14, height: 14, borderRadius: 7, borderWidth: 2.5 },
  rowText: { flex: 1, minWidth: 0, gap: 2 },
  alias: { fontSize: 17, fontWeight: "700", letterSpacing: -0.2 },
  host: { fontSize: 13, fontFamily: "monospace" },
  meta: { fontSize: 12, fontWeight: "600", marginTop: 1 },
  steps: { gap: 10, marginTop: 16 },
  step: { flexDirection: "row", gap: 12, padding: 14, borderRadius: radius.lg, alignItems: "flex-start" },
  stepIndex: { width: 28, height: 28, borderRadius: 9, alignItems: "center", justifyContent: "center" },
  stepIndexText: { fontSize: 14, fontWeight: "800" },
  stepText: { flex: 1, gap: 3 },
  stepTitle: { fontSize: 15, fontWeight: "700" },
  stepBody: { fontSize: 13, lineHeight: 19 },
});
