import { useEffect, useRef, useState, type JSX } from "react";
import { ActivityIndicator, AppState, Modal, Pressable, ScrollView, StyleSheet, Text, View, useWindowDimensions } from "react-native";
import type { File } from "expo-file-system";
import { HugeiconsIcon } from "@hugeicons/react-native";
import { DesktopSpinner } from "../chat/desktop-spinner";
import { t, useT } from "../i18n";
import { Alert02Icon, ArrowUp02Icon } from "../ui/icons";
import { toast } from "../ui/toast";
import { elevation, radius, usePalette } from "../ui/theme";
import { useOpenSheets } from "../ui/overlay";
import type { AppRelease } from "./release";
import {
  announceRelease,
  checkForUpdate,
  clearSkippedVersion,
  currentVersion,
  describeCheckError,
  downloadApk,
  downloadedApk,
  installApk,
  onReleaseAnnounced,
  removeStaleApks,
  skipVersion,
  skippedVersion,
  updatesSupported,
} from "./updater";

type Phase =
  | { kind: "available" }
  | { kind: "downloading"; progress: number | null }
  | { kind: "ready"; file: File }
  | { kind: "installing" }
  | { kind: "error"; message: string };

/** Longest stretch of release notes shown in the update dialog. */
const NOTES_LIMIT = 600;

/**
 * A global update dialog. It is mounted in the root layout rather than a screen so
 * an update found while the user is in a chat is still visible. Confirmation,
 * download progress and the final install action all stay in this one modal.
 */
export function UpdatePrompt(): JSX.Element | null {
  useT();
  const palette = usePalette();
  const { height } = useWindowDimensions();
  const sheets = useOpenSheets();
  const [release, setRelease] = useState<AppRelease | null>(null);
  const [phase, setPhase] = useState<Phase>({ kind: "available" });
  const abort = useRef<AbortController | null>(null);
  const shownVersion = useRef<string | null>(null);
  const downloading = useRef(false);
  downloading.current = phase.kind === "downloading";

  useEffect(() => {
    if (!updatesSupported) return undefined;
    removeStaleApks();
    let live = true;
    const show = (found: AppRelease): void => {
      if (!live || found.version === shownVersion.current || downloading.current) return;
      shownVersion.current = found.version;
      setRelease(found);
      const file = downloadedApk(found);
      setPhase(file ? { kind: "ready", file } : { kind: "available" });
    };
    const check = (): void => {
      void Promise.all([checkForUpdate(), skippedVersion()])
        .then(([found, skipped]) => {
          if (found && found.version !== skipped) show(found);
        })
        .catch(() => {
          // Automatic checks stay quiet; Settings → About gives the user the reason.
        });
    };
    // Register before starting the check so a cached result cannot beat the listener.
    const unannounce = onReleaseAnnounced(show);
    check();
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") check();
    });
    return () => {
      live = false;
      unannounce();
      subscription.remove();
      abort.current?.abort();
    };
  }, []);

  if (!release || sheets > 0) return null;

  const busy = phase.kind === "downloading" || phase.kind === "installing";
  const notes = release.notes.length > NOTES_LIMIT ? `${release.notes.slice(0, NOTES_LIMIT)}…` : release.notes;
  const title =
    phase.kind === "downloading"
      ? phase.progress === null
        ? t("update.downloading")
        : t("update.downloadingPercent", { percent: Math.round(phase.progress * 100) })
      : phase.kind === "ready"
        ? t("update.downloaded", { version: release.version })
        : phase.kind === "installing"
          ? t("update.installing")
          : phase.kind === "error"
            ? t("update.failed")
            : t("update.available", { version: release.version });
  const message = phase.kind === "error" ? phase.message : phase.kind === "ready" ? t("update.tapToInstall") : notes || t("update.confirmBody");

  function later(): void {
    if (busy) return;
    abort.current?.abort();
    abort.current = null;
    shownVersion.current = null;
    setRelease(null);
    setPhase({ kind: "available" });
  }

  function ignore(): void {
    if (!release || busy) return;
    void skipVersion(release.version);
    later();
  }

  async function download(): Promise<void> {
    if (!release || busy) return;
    const target = release;
    const controller = new AbortController();
    abort.current = controller;
    setPhase({ kind: "downloading", progress: 0 });
    try {
      const file = await downloadApk(target, (progress) => setPhase({ kind: "downloading", progress }), controller.signal);
      if (controller.signal.aborted) return;
      abort.current = null;
      setPhase({ kind: "ready", file });
    } catch (error) {
      if (controller.signal.aborted) return;
      abort.current = null;
      setPhase({ kind: "error", message: error instanceof Error ? error.message : t("update.downloadFailed") });
    }
  }

  async function install(file: File): Promise<void> {
    setPhase({ kind: "installing" });
    try {
      await installApk(file);
      // Returning means the user dismissed the system installer. Keep the install
      // action available rather than claiming that the update succeeded.
      setPhase({ kind: "ready", file });
    } catch (error) {
      setPhase({ kind: "error", message: error instanceof Error ? error.message : t("update.installerFailed") });
    }
  }

  const icon = phase.kind === "error" ? Alert02Icon : ArrowUp02Icon;
  const progress = phase.kind === "downloading" ? phase.progress : null;

  return (
    <Modal transparent visible animationType="fade" onRequestClose={later} statusBarTranslucent>
      <Pressable style={[styles.backdrop, { backgroundColor: palette.overlay }]} onPress={later}>
        <Pressable style={[styles.card, elevation(palette, 2), { backgroundColor: palette.card }]} onPress={() => undefined}>
          <View style={styles.heading}>
            <View style={[styles.icon, { backgroundColor: phase.kind === "error" ? palette.danger : palette.accent }]}>
              {busy ? <DesktopSpinner color="#ffffff" size={17} /> : <HugeiconsIcon icon={icon} size={18} color="#ffffff" strokeWidth={2.4} />}
            </View>
            <View style={styles.headingText}>
              <Text style={[styles.title, { color: palette.text }]}>{title}</Text>
              {phase.kind === "available" ? <Text style={[styles.subtitle, { color: palette.muted }]}>{t("update.confirmBody")}</Text> : null}
            </View>
          </View>
          <ScrollView style={{ maxHeight: height * 0.36 }} contentContainerStyle={styles.messageBox}>
            <Text style={[styles.message, { color: phase.kind === "error" ? palette.danger : palette.muted }]}>{message}</Text>
          </ScrollView>
          {phase.kind === "downloading" ? (
            progress === null ? (
              <ActivityIndicator color={palette.accent} />
            ) : (
              <View accessibilityRole="progressbar" accessibilityValue={{ min: 0, max: 100, now: Math.round(progress * 100) }} style={[styles.progressTrack, { backgroundColor: palette.field }]}>
                <View style={[styles.progressFill, { backgroundColor: palette.accent, width: `${Math.max(2, Math.round(progress * 100))}%` }]} />
              </View>
            )
          ) : null}
          <View style={styles.actions}>
            {phase.kind === "available" ? (
              <>
                <Action label={t("common.cancel")} palette={palette} style="cancel" onPress={later} />
                <Action label={t("update.update")} palette={palette} onPress={() => void download()} />
              </>
            ) : phase.kind === "downloading" ? (
              <Action label={t("common.cancel")} palette={palette} style="cancel" onPress={later} />
            ) : phase.kind === "ready" ? (
              <>
                <Action label={t("common.cancel")} palette={palette} style="cancel" onPress={later} />
                <Action label={t("update.install")} palette={palette} onPress={() => void install(phase.file)} />
              </>
            ) : phase.kind === "error" ? (
              <>
                <Action label={t("common.cancel")} palette={palette} style="cancel" onPress={later} />
                <Action label={t("update.retry")} palette={palette} onPress={() => void download()} />
              </>
            ) : null}
          </View>
          {phase.kind === "available" ? (
            <Pressable accessibilityRole="button" accessibilityLabel={t("update.ignore")} onPress={ignore} style={styles.ignore}>
              <Text style={[styles.ignoreText, { color: palette.muted }]}>{t("update.ignore")}</Text>
            </Pressable>
          ) : null}
        </Pressable>
      </Pressable>
    </Modal>
  );
}

function Action({ label, palette, style = "default", onPress }: { label: string; palette: ReturnType<typeof usePalette>; style?: "default" | "cancel"; onPress: () => void }): JSX.Element {
  const accent = style === "cancel" ? palette.field : palette.accent;
  const color = style === "cancel" ? palette.text : "#ffffff";
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={label} onPress={onPress} style={({ pressed }) => [styles.action, { backgroundColor: accent, opacity: pressed ? 0.8 : 1 }]}>
      <Text style={[styles.actionText, { color }]}>{label}</Text>
    </Pressable>
  );
}

/** Settings → Check for updates. A manual check always answers and hands a found release to the global dialog. */
export async function checkForUpdatesManually(): Promise<void> {
  try {
    const found = await checkForUpdate({ force: true });
    if (!found) {
      toast.success(t("update.upToDateVersion", { version: currentVersion() }));
      return;
    }
    await clearSkippedVersion();
    announceRelease(found);
  } catch (error) {
    toast.error(t("toast.failedWith", { title: t("update.checkFailed"), message: describeCheckError(error) }));
  }
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, justifyContent: "center", padding: 28 },
  card: { borderRadius: radius.xl, padding: 20, gap: 12, width: "100%", maxWidth: 420, alignSelf: "center" },
  heading: { flexDirection: "row", alignItems: "center", gap: 12 },
  headingText: { flex: 1, gap: 3 },
  icon: { width: 38, height: 38, borderRadius: 12, alignItems: "center", justifyContent: "center" },
  title: { fontSize: 18, fontWeight: "700", lineHeight: 24 },
  subtitle: { fontSize: 13, lineHeight: 18 },
  messageBox: { paddingBottom: 2 },
  message: { fontSize: 15, lineHeight: 22 },
  progressTrack: { height: 8, borderRadius: 999, overflow: "hidden" },
  progressFill: { height: "100%", borderRadius: 999 },
  actions: { flexDirection: "row", gap: 10, marginTop: 4 },
  action: { flex: 1, minHeight: 46, borderRadius: radius.md, alignItems: "center", justifyContent: "center", paddingHorizontal: 12 },
  actionText: { fontSize: 16, fontWeight: "700" },
  ignore: { alignSelf: "center", padding: 4 },
  ignoreText: { fontSize: 14 },
});
