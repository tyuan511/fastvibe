import { useEffect, useRef, useState, type JSX } from "react";
import { Alert, Pressable, StyleSheet, Text, View } from "react-native";
import type { File } from "expo-file-system";
import { DesktopSpinner } from "../chat/desktop-spinner";
import type { Palette } from "../ui/theme";
import type { AppRelease } from "./release";
import {
  checkForUpdate,
  downloadApk,
  downloadedApk,
  installApk,
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
 * A new version, offered at the top of the device list. Checked once per launch and
 * silent when it fails: an unreachable GitHub is not something to interrupt the
 * list for. 忽略 stops offering that one version, not updates.
 */
export function UpdateBanner({ palette }: { palette: Palette }): JSX.Element | null {
  const [release, setRelease] = useState<AppRelease | null>(null);
  const [phase, setPhase] = useState<Phase>({ kind: "available" });
  const abort = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!updatesSupported) return;
    removeStaleApks();
    let live = true;
    void Promise.all([checkForUpdate(), skippedVersion()])
      .then(([found, skipped]) => {
        if (!live || !found || found.version === skipped) return;
        setRelease(found);
        const file = downloadedApk(found);
        if (file) setPhase({ kind: "ready", file });
      })
      .catch(() => {});
    return () => {
      live = false;
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

const styles = StyleSheet.create({
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
