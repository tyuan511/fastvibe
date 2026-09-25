import { useEffect, useRef, useState, type JSX } from "react";
import { Alert, AppState, Pressable, StyleSheet, Text, View } from "react-native";
import type { File } from "expo-file-system";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { DesktopSpinner } from "../chat/desktop-spinner";
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
      setPhase({ kind: "error", message: error instanceof Error ? error.message : "无法打开安装程序" });
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
      setPhase({ kind: "error", message: error instanceof Error ? error.message : "下载失败" });
    }
  }

  function confirm(target: AppRelease): void {
    const notes = target.notes.length > NOTES_LIMIT ? `${target.notes.slice(0, NOTES_LIMIT)}…` : target.notes;
    Alert.alert(`更新到 ${target.version}`, notes || "下载安装包并打开系统安装程序。", [
      { text: "取消", style: "cancel" },
      { text: "更新", onPress: () => void download(target) },
    ]);
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
        ? "正在下载…"
        : `正在下载 ${Math.round(phase.progress * 100)}%`
      : phase.kind === "ready"
        ? `${release.version} 已下载`
        : phase.kind === "error"
          ? "更新失败"
          : `发现新版本 ${release.version}`;
  const detail = phase.kind === "error" ? phase.message : phase.kind === "ready" ? "点按安装" : null;
  const action = phase.kind === "ready" ? "安装" : phase.kind === "error" ? "重试" : phase.kind === "available" ? "更新" : null;

  function press(target: AppRelease): void {
    if (phase.kind === "ready") void install(phase.file);
    else if (phase.kind === "error") void download(target);
    else if (phase.kind === "available") confirm(target);
  }

  return (
    <Pressable
      disabled={busy}
      onPress={() => press(release)}
      style={[styles.banner, { backgroundColor: palette.card, borderColor: palette.border }]}
    >
      {busy ? <DesktopSpinner color={palette.muted} size={16} /> : null}
      <View style={styles.text}>
        <Text style={[styles.title, { color: phase.kind === "error" ? palette.danger : palette.text }]}>{title}</Text>
        {detail ? (
          <Text style={[styles.detail, { color: palette.muted }]} numberOfLines={2}>
            {detail}
          </Text>
        ) : null}
      </View>
      {action ? <Text style={[styles.action, { color: palette.accent }]}>{action}</Text> : null}
      {phase.kind === "available" ? (
        <Pressable onPress={() => dismiss(release)} hitSlop={8}>
          <Text style={[styles.action, { color: palette.muted }]}>忽略</Text>
        </Pressable>
      ) : null}
    </Pressable>
  );
}

/**
 * The installed version and a manual 检查更新 under the device list. The automatic
 * check is silent on failure by design, which made a phone that cannot reach GitHub
 * look exactly like one that is up to date; asking by hand always answers.
 */
export function UpdateCheckFooter({ palette }: { palette: Palette }): JSX.Element | null {
  const insets = useSafeAreaInsets();
  const [checking, setChecking] = useState(false);

  if (!updatesSupported) return null;

  async function check(): Promise<void> {
    setChecking(true);
    try {
      const found = await checkForUpdate({ force: true });
      if (!found) {
        Alert.alert("已是最新版本", `当前版本 ${currentVersion()}`);
        return;
      }
      await clearSkippedVersion();
      announceRelease(found);
    } catch (error) {
      Alert.alert("检查更新失败", describeCheckError(error));
    } finally {
      setChecking(false);
    }
  }

  return (
    <View style={[styles.footer, { paddingBottom: Math.max(insets.bottom, 12) }]}>
      <Text style={[styles.footerText, { color: palette.muted }]}>FastVibe {currentVersion()}</Text>
      <Text style={[styles.footerText, { color: palette.muted }]}>·</Text>
      <Pressable disabled={checking} onPress={() => void check()} hitSlop={8}>
        <Text style={[styles.footerText, { color: checking ? palette.muted : palette.accent }]}>
          {checking ? "检查中…" : "检查更新"}
        </Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  footer: { flexDirection: "row", justifyContent: "center", alignItems: "center", gap: 6, paddingTop: 12 },
  footerText: { fontSize: 13 },
  banner: {
    marginHorizontal: 16,
    marginTop: 12,
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 16,
    paddingVertical: 12,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  text: { flex: 1, gap: 2 },
  title: { fontSize: 15, fontWeight: "600" },
  detail: { fontSize: 13 },
  action: { fontSize: 15, fontWeight: "600" },
});
