import { useRef, useState, type JSX } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { HugeiconsIcon } from "@hugeicons/react-native";
import { Cancel01Icon } from "../ui/icons";
import { usePalette } from "../ui/theme";
import type { QueueState } from "./queue";

export function QueuePanel({ queue, disabled, onCancel, onResume }: {
  queue: QueueState;
  disabled: boolean;
  onCancel: (id: string) => Promise<void>;
  onResume: () => Promise<void>;
}): JSX.Element | null {
  const palette = usePalette();
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
        <Text style={[styles.title, { color: palette.muted }]}>
          {queue.pause ? `队列已暂停 · ${queue.items.length} 条` : `${queue.items.length} 条排队中`}
        </Text>
        {queue.pause ? (
          <Pressable accessibilityRole="button" disabled={locked} onPress={() => void act(onResume)} style={[styles.resume, { borderColor: palette.border, opacity: locked ? 0.4 : 1 }]}>
            <Text style={{ color: palette.text, fontSize: 12 }}>继续发送</Text>
          </Pressable>
        ) : null}
      </View>
      {queue.pause ? <Text style={{ color: palette.muted, fontSize: 12 }}>{queue.pause === "stopped" ? "已停止当前响应，待发送消息保留在队列中" : "响应出错，待发送消息保留在队列中"}</Text> : null}
      <ScrollView style={styles.list} keyboardShouldPersistTaps="handled" nestedScrollEnabled>
        {queue.items.map((item) => (
          <View key={item.id} style={styles.item}>
            <View style={styles.itemText}>
              <Text numberOfLines={2} style={{ color: palette.text, fontSize: 14 }}>{item.text}</Text>
              <Text style={{ color: palette.muted, fontSize: 12 }}>{item.claimed ? "已提交" : item.sending ? "等待注入" : item.behavior === "steer" ? "下一步插入" : "本轮结束后发送"}</Text>
            </View>
            <Pressable accessibilityRole="button" accessibilityLabel="移除排队消息" disabled={locked || item.claimed} onPress={() => void act(() => onCancel(item.id))} style={[styles.remove, { opacity: locked || item.claimed ? 0.35 : 1 }]}>
              <HugeiconsIcon icon={Cancel01Icon} size={16} color={palette.muted} strokeWidth={2} />
            </Pressable>
          </View>
        ))}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  panel: { flexShrink: 1, marginHorizontal: 12, marginBottom: 6, borderWidth: StyleSheet.hairlineWidth, borderRadius: 12, paddingHorizontal: 10, paddingVertical: 7, gap: 3 },
  header: { flexDirection: "row", alignItems: "center", minHeight: 32 },
  title: { flex: 1, fontSize: 12, fontWeight: "600" },
  resume: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 999, paddingHorizontal: 10, paddingVertical: 8 },
  list: { maxHeight: 144, flexGrow: 0 },
  item: { flexDirection: "row", alignItems: "center", gap: 8, minHeight: 44, paddingVertical: 3 },
  itemText: { flex: 1, minWidth: 0, gap: 1 },
  remove: { width: 40, height: 40, alignItems: "center", justifyContent: "center" },
});
