import { memo, useState, type JSX } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { HugeiconsIcon } from "@hugeicons/react-native";
import { AiBrain01Icon, ArrowRight01Icon } from "../ui/icons";
import type { Palette } from "../ui/theme";
import { useT } from "../i18n";
import { DesktopSpinner } from "./desktop-spinner";

/**
 * A reply's thinking as one row of a process card (`ProcessGroup`), laid out exactly
 * like a tool call's row: the icon tile, the label, the first words, and the full text
 * behind a tap. The desktop's mental model — a brain, then the text on demand —
 * without its duration, which the phone's transcript does not carry.
 */
export const ThinkingRow = memo(function ThinkingRow({
  text,
  palette,
  live = false,
}: {
  text: string;
  palette: Palette;
  /** The block is still streaming. */
  live?: boolean;
}): JSX.Element {
  const { t } = useT();
  const [open, setOpen] = useState(false);
  const preview = text.replace(/\s+/g, " ").trim();
  return (
    <View>
      <Pressable onPress={() => setOpen(!open)} style={({ pressed }) => [styles.row, pressed ? { backgroundColor: palette.field } : null]}>
        <View style={[styles.icon, { backgroundColor: live ? palette.accentSoft : palette.field }]}>
          {live ? (
            <DesktopSpinner size={13} color={palette.accent} />
          ) : (
            <HugeiconsIcon icon={AiBrain01Icon} size={13} color={palette.muted} strokeWidth={2} />
          )}
        </View>
        <Text style={[styles.label, { color: live ? palette.accent : palette.muted }]}>{live ? t("chat.thinking") : t("chat.thoughts")}</Text>
        <Text style={[styles.preview, { color: palette.text }]} numberOfLines={1}>
          {open ? "" : preview}
        </Text>
        <View style={open ? styles.chevronOpen : undefined}>
          <HugeiconsIcon icon={ArrowRight01Icon} size={14} color={palette.subtle} strokeWidth={2} />
        </View>
      </Pressable>
      {open ? (
        <View style={styles.detail}>
          <View style={[styles.block, { backgroundColor: palette.field }]}>
            <Text selectable style={[styles.bodyText, { color: palette.muted }]}>{text.trim()}</Text>
          </View>
        </View>
      ) : null}
    </View>
  );
});

const styles = StyleSheet.create({
  // Same measurements as a tool call's row in `tool-card.tsx`, so the two read as one list.
  row: { width: "100%", minHeight: 40, flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 10, paddingVertical: 7 },
  icon: { width: 24, height: 24, borderRadius: 7, alignItems: "center", justifyContent: "center" },
  label: { flexShrink: 0, fontSize: 13, fontWeight: "600" },
  preview: { flex: 1, minWidth: 0, fontSize: 13 },
  chevronOpen: { transform: [{ rotate: "90deg" }] },
  detail: { paddingHorizontal: 10, paddingBottom: 10 },
  block: { borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10 },
  bodyText: { fontSize: 14, lineHeight: 21 },
});
