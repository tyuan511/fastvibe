import type { JSX } from "react";
import { Modal, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { usePalette } from "./theme";

export function TextPrompt({
  title,
  value,
  onChange,
  onCancel,
  onSubmit,
}: {
  title: string;
  value: string;
  onChange: (value: string) => void;
  onCancel: () => void;
  onSubmit: () => void;
}): JSX.Element {
  const palette = usePalette();
  return (
    <Modal transparent animationType="fade" onRequestClose={onCancel}>
      <Pressable style={styles.backdrop} onPress={onCancel}>
        <Pressable style={[styles.sheet, { backgroundColor: palette.card }]} onPress={() => undefined}>
          <Text style={[styles.title, { color: palette.text }]}>{title}</Text>
          <TextInput
            value={value}
            onChangeText={onChange}
            autoFocus
            style={[styles.input, { color: palette.text, borderColor: palette.border, backgroundColor: palette.background }]}
          />
          <View style={styles.row}>
            <Pressable onPress={onCancel} style={styles.button}>
              <Text style={{ color: palette.muted, fontSize: 16 }}>取消</Text>
            </Pressable>
            <Pressable onPress={onSubmit} style={styles.button}>
              <Text style={{ color: palette.accent, fontSize: 16, fontWeight: "600" }}>保存</Text>
            </Pressable>
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.4)", justifyContent: "center", padding: 28 },
  sheet: { borderRadius: 16, padding: 16, gap: 12 },
  title: { fontSize: 17, fontWeight: "600" },
  input: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, fontSize: 16 },
  row: { flexDirection: "row", justifyContent: "flex-end", gap: 8 },
  button: { paddingHorizontal: 12, paddingVertical: 8 },
});
