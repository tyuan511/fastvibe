import type { JSX } from "react";
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { usePalette } from "../ui/theme";

export type OptionGroup = {
  label: string;
  options: Array<{ value: string; label: string; description?: string }>;
};

/** Bottom sheet of options — the RN version of the mobile.html option-sheet. */
export function OptionSheet({
  open,
  title,
  groups,
  value,
  onSelect,
  onClose,
}: {
  open: boolean;
  title: string;
  groups: OptionGroup[];
  value: string | null;
  onSelect: (value: string) => void;
  onClose: () => void;
}): JSX.Element {
  const palette = usePalette();
  const insets = useSafeAreaInsets();
  return (
    <Modal transparent animationType="slide" visible={open} onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose}>
        <Pressable
          style={[styles.sheet, { backgroundColor: palette.card, paddingBottom: insets.bottom + 16 }]}
          onPress={() => undefined}
        >
          <View style={[styles.grabber, { backgroundColor: palette.border }]} />
          <Text style={[styles.title, { color: palette.text }]}>{title}</Text>
          <ScrollView style={styles.scroll} bounces={false}>
            {groups.map((group) => (
              <View key={group.label} style={styles.group}>
                {groups.length > 1 ? <Text style={[styles.groupLabel, { color: palette.muted }]}>{group.label}</Text> : null}
                {group.options.map((option) => {
                  const selected = option.value === value;
                  return (
                    <Pressable
                      key={option.value}
                      onPress={() => {
                        onSelect(option.value);
                        onClose();
                      }}
                      style={[styles.row, selected ? { backgroundColor: palette.background } : null]}
                    >
                      <View style={styles.rowText}>
                        <Text style={[styles.rowLabel, { color: palette.text }]} numberOfLines={1}>
                          {option.label}
                        </Text>
                        {option.description ? (
                          <Text style={[styles.rowDescription, { color: palette.muted }]} numberOfLines={2}>
                            {option.description}
                          </Text>
                        ) : null}
                      </View>
                      {selected ? <Text style={{ color: palette.accent, fontSize: 16 }}>✓</Text> : null}
                    </Pressable>
                  );
                })}
              </View>
            ))}
          </ScrollView>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.4)", justifyContent: "flex-end" },
  sheet: { borderTopLeftRadius: 18, borderTopRightRadius: 18, paddingHorizontal: 16, paddingTop: 8, maxHeight: "72%" },
  grabber: { alignSelf: "center", width: 36, height: 4, borderRadius: 2, marginBottom: 10 },
  title: { fontSize: 17, fontWeight: "600", marginBottom: 8 },
  scroll: { flexGrow: 0 },
  group: { marginBottom: 12, gap: 4 },
  groupLabel: { fontSize: 13, fontWeight: "600", paddingHorizontal: 4, marginBottom: 2 },
  row: { flexDirection: "row", alignItems: "center", gap: 8, borderRadius: 12, paddingHorizontal: 12, paddingVertical: 12 },
  rowText: { flex: 1, gap: 2 },
  rowLabel: { fontSize: 16 },
  rowDescription: { fontSize: 13, lineHeight: 18 },
});
