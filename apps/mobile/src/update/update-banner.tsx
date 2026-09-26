import { useEffect, useRef, useState, type JSX } from "react";
import { AppState, Pressable, StyleSheet, Text, View } from "react-native";
import type { File } from "expo-file-system";
import { HugeiconsIcon } from "@hugeicons/react-native";
import { DesktopSpinner } from "../chat/desktop-spinner";
import { t, useT } from "../i18n";
import { Alert02Icon, ArrowUp02Icon } from "../ui/icons";
import { dialog } from "../ui/dialog";
import { toast } from "../ui/toast";
import type { Palette } from "../ui/theme";
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
  | { kind: "error"; message: string };

/** Longest stretch of release notes put in the confirmation dialog. */
const NOTES_LIMIT = 600;

/**
 * A new version, offered at the top of the device list. Checked on mount and again
 * whenever the app comes back to the foreground — the list is the root screen and
 * never unmounts, so mounting alone meant one look per process. Silent when it
 * fails: an unreachable GitHub is not something to interrupt the list for. 忽略
 * stops offering that one version, not updates.
 */
export function UpdateBanner({ palette }: { palette: Palette }): JSX.Element | null {
  useT();
  const [release, setRelease] = useState<AppRelease | null>(null);
  const [phase, setPhase] = useState<Phase>({ kind: "available" });
  const abort = useRef<AbortController | null>(null);
  const shownVersion = useRef<string | null>(null);
  const downloading = useRef(false);
  downloading.current = phase.kind === "downloading";

  useEffect(() => {
    if (!updatesSupported) return;
    removeStaleApks();
    let live = true;
    const show = (found: AppRelease): void => {
      // Same version already on screen, or a download in progress: leave it alone.
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
        .catch(() => {});
    };
    check();
    const unannounce = onReleaseAnnounced(show);
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

  if (!release) return null;

  async function install(file: File): Promise<void> {
    try {
      await installApk(file);
    } catch (error) {
      setPhase({ kind: "error", message: error instanceof Error ? error.message : t("update.installerFailed") });
    }
  }

  async function download(target: AppRelease): Promise<void> {
    const controller = new AbortController();
    abort.current = controller;
    setPhase({ kind: "downloading", progress: 0 });
    try {
      const file = await downloadApk(target, (progress) => setPhase({ kind: "downloading", progress }), controller.signal);
      setPhase({ kind: "ready", file });
      await install(file);
    } catch (error) {
      if (controller.signal.aborted) return;
      setPhase({ kind: "error", message: error instanceof Error ? error.message : t("update.downloadFailed") });
    }
  }

  function confirm(target: AppRelease): void {
    const notes = target.notes.length > NOTES_LIMIT ? `${target.notes.slice(0, NOTES_LIMIT)}…` : target.notes;
    dialog.confirm({
      title: t("update.confirmTitle", { version: target.version }),
      message: notes || t("update.confirmBody"),
      confirmLabel: t("update.update"),
      onConfirm: () => void download(target),
    });
  }

  function dismiss(target: AppRelease): void {
    void skipVersion(target.version);
    shownVersion.current = null;
    setRelease(null);
  }

  const busy = phase.kind === "downloading";
  const title =
    phase.kind === "downloading"
      ? phase.progress === null
        ? t("update.downloading")
        : t("update.downloadingPercent", { percent: Math.round(phase.progress * 100) })
      : phase.kind === "ready"
        ? t("update.downloaded", { version: release.version })
        : phase.kind === "error"
          ? t("update.failed")
          : t("update.available", { version: release.version });
  const detail = phase.kind === "error" ? phase.message : phase.kind === "ready" ? t("update.tapToInstall") : null;
  const action = phase.kind === "ready" ? t("update.install") : phase.kind === "error" ? t("update.retry") : phase.kind === "available" ? t("update.update") : null;

  function press(target: AppRelease): void {
    if (phase.kind === "ready") void install(phase.file);
    else if (phase.kind === "error") void download(target);
    else if (phase.kind === "available") confirm(target);
  }

  return (
    <View style={[styles.banner, { backgroundColor: palette.accentSoft }]}>
      <Pressable
        disabled={busy}
        onPress={() => press(release)}
        style={({ pressed }) => [styles.main, { opacity: pressed ? 0.8 : 1 }]}
      >
        <View style={[styles.icon, { backgroundColor: phase.kind === "error" ? palette.danger : palette.accent }]}>
        {busy ? (
          <DesktopSpinner color="#ffffff" size={16} />
        ) : (
          <HugeiconsIcon icon={phase.kind === "error" ? Alert02Icon : ArrowUp02Icon} size={17} color="#ffffff" strokeWidth={2.4} />
        )}
      </View>
        <View style={styles.text}>
          <Text style={[styles.title, { color: phase.kind === "error" ? palette.danger : palette.text }]}>{title}</Text>
          {detail ? (
            <Text style={[styles.detail, { color: palette.muted }]} numberOfLines={2}>
              {detail}
            </Text>
          ) : null}
        </View>
      </Pressable>
      {action ? (
        <Pressable
          disabled={busy}
          accessibilityRole="button"
          accessibilityLabel={action}
          onPress={() => press(release)}
          style={({ pressed }) => [styles.actionPill, { backgroundColor: palette.accent, opacity: pressed ? 0.8 : 1 }]}
        >
          <Text style={[styles.action, { color: palette.accentText }]}>{action}</Text>
        </Pressable>
      ) : null}
      {phase.kind === "available" ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t("update.ignore")}
          onPress={() => dismiss(release)}
          hitSlop={8}
          style={({ pressed }) => ({ opacity: pressed ? 0.55 : 1 })}
        >
          <Text style={[styles.action, { color: palette.muted }]}>{t("update.ignore")}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

/**
 * 设置 → 检查更新. The automatic check is silent on failure by design, which made a
 * phone that cannot reach GitHub look exactly like one that is up to date; asking by
 * hand always answers. A release it finds goes to the banner (`announceRelease`),
 * which owns download and install.
 */
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
  banner: {
    borderRadius: 16,
    paddingHorizontal: 12,
    paddingVertical: 12,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  main: { flex: 1, flexDirection: "row", alignItems: "center", gap: 12 },
  icon: { width: 34, height: 34, borderRadius: 11, alignItems: "center", justifyContent: "center" },
  actionPill: { borderRadius: 999, paddingHorizontal: 12, paddingVertical: 6 },
  text: { flex: 1, gap: 2 },
  title: { fontSize: 15, fontWeight: "600" },
  detail: { fontSize: 13 },
  action: { fontSize: 14, fontWeight: "700" },
});
