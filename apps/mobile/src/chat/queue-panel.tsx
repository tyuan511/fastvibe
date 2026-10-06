import { useRef, useState, type JSX } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { HugeiconsIcon } from "@hugeicons/react-native";
import { Cancel01Icon, Clock01Icon } from "../ui/icons";
import { radius, usePalette } from "../ui/theme";
import type { QueueState } from "./queue";
import { useT } from "../i18n";

export function QueuePanel({ queue, disabled, onCancel, onResume }: {
  queue: QueueState;
  disabled: boolean;
  onCancel: (id: string) => Promise<void>;
  onResume: () => Promise<void>;
}): JSX.Element | null {
  const palette = usePalette();
  const { t } = useT();
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  async function act(work: () => Promise<void>): Promise<void> {
    if (pending.current || disabled) return;
    pending.current = true;
    setBusy(true);
    try { await work(); } finally { pending.current = false; setBusy(false); }
  }
  if (!queue.items.length) return null;
  const locked = disabled || busy;
  return (
    <View style={[styles.panel, { backgroundColor: palette.card, borderColor: palette.border }]}>
      <View style={styles.header}>
        <HugeiconsIcon icon={Clock01Icon} size={14} color={queue.pause ? palette.warning : palette.accent} strokeWidth={2.2} />
        <Text style={[styles.title, { color: queue.pause ? palette.warning : palette.text }]}>
          {queue.pause ? t("queue.paused", { count: queue.items.length }) : t("queue.pending", { count: queue.items.length })}
        </Text>
        {queue.pause ? (
          <Pressable accessibilityRole="button" disabled={locked} onPress={() => void act(onResume)} style={[styles.resume, { backgroundColor: palette.accent, opacity: locked ? 0.4 : 1 }]}>
            <Text style={{ color: palette.accentText, fontSize: 12, fontWeight: "700" }}>{t("queue.resume")}</Text>
          </Pressable>
        ) : null}
      </View>
      {queue.pause ? <Text style={{ color: palette.muted, fontSize: 12 }}>{queue.pause === "stopped" ? t("queue.stoppedNote") : t("queue.errorNote")}</Text> : null}
      <ScrollView style={styles.list} keyboardShouldPersistTaps="handled" nestedScrollEnabled>
        {queue.items.map((item) => (
          <View key={item.id} style={[styles.item, { backgroundColor: palette.field }]}>
            <View style={styles.itemText}>
              <Text numberOfLines={2} style={{ color: palette.text, fontSize: 14 }}>{item.text}</Text>
              <Text style={{ color: palette.muted, fontSize: 12 }}>{item.claimed ? t("queue.claimed") : item.sending ? t("queue.sending") : item.behavior === "steer" ? t("queue.steer") : t("queue.followUp")}</Text>
            </View>
            <Pressable accessibilityRole="button" accessibilityLabel={t("queue.remove")} disabled={locked || item.claimed} onPress={() => void act(() => onCancel(item.id))} style={[styles.remove, { opacity: locked || item.claimed ? 0.35 : 1 }]}>
              <HugeiconsIcon icon={Cancel01Icon} size={16} color={palette.muted} strokeWidth={2} />
            </Pressable>
          </View>
        ))}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  panel: { flexShrink: 1, marginHorizontal: 10, marginBottom: 4, borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.lg, paddingHorizontal: 12, paddingVertical: 8, gap: 4 },
  header: { flexDirection: "row", alignItems: "center", gap: 6, minHeight: 30 },
  title: { flex: 1, fontSize: 13, fontWeight: "700" },
  resume: { borderRadius: 999, paddingHorizontal: 12, paddingVertical: 7 },
  list: { maxHeight: 160, flexGrow: 0 },
  item: { flexDirection: "row", alignItems: "center", gap: 8, minHeight: 44, paddingLeft: 10, paddingVertical: 4, borderRadius: radius.md, marginTop: 4 },
  itemText: { flex: 1, minWidth: 0, gap: 1 },
  remove: { width: 40, height: 40, alignItems: "center", justifyContent: "center" },
});
