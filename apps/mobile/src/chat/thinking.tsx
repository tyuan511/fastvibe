import { memo, useState, type JSX } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { HugeiconsIcon } from "@hugeicons/react-native";
import { ArrowRight01Icon, BrainIcon } from "../ui/icons";
import type { Palette } from "../ui/theme";

/** Same mental model as the desktop: collapsed brain icon + duration + optional full text. */
export const ThinkingBlock = memo(function ThinkingBlock({
  text,
  palette,
}: {
  text: string;
  palette: Palette;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  return (
    <View>
      <Pressable onPress={() => setOpen(!open)} style={styles.trigger}>
        <HugeiconsIcon icon={BrainIcon} size={16} color={palette.muted} strokeWidth={2} />
        <Text style={[styles.label, { color: palette.muted }]}>
          思考
        </Text>
        <HugeiconsIcon icon={ArrowRight01Icon} size={16} color={palette.muted} strokeWidth={2} style={open ? styles.chevronOpen : undefined} />
      </Pressable>
      {open ? (
        <View style={[styles.body, { borderLeftColor: palette.border }]}>
          <Text style={[styles.bodyText, { color: palette.muted }]}>{text}</Text>
        </View>
      ) : null}
    </View>
  );
});

const styles = StyleSheet.create({
  trigger: { flexDirection: "row", alignItems: "center", gap: 6, paddingVertical: 2 },
  chevronOpen: { transform: [{ rotate: "90deg" }] },
  label: { fontSize: 14, fontWeight: "500" },
  chevron: { fontSize: 12 },
  body: { marginLeft: 10, borderLeftWidth: StyleSheet.hairlineWidth, paddingLeft: 9, paddingVertical: 4 },
  bodyText: { fontSize: 14, lineHeight: 20, fontStyle: "italic" },
});
