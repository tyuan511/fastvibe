import { useEffect, useMemo, useState, type JSX } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react-native";
import { Tick02Icon } from "../ui/icons";
import { Sheet } from "../ui/sheet";
import { Avatar, SearchField } from "../ui/kit";
import { haptic } from "../ui/haptics";
import { radius, usePalette } from "../ui/theme";
import { useT } from "../i18n";

export type SheetOption = {
  value: string;
  label: string;
  description?: string;
  icon?: IconSvgElement;
  /** Draw a coloured initial for this name instead of an icon (a project). */
  avatar?: string;
  destructive?: boolean;
};

export type OptionGroup = {
  label: string;
  options: SheetOption[];
};

/** Past this many options a sheet grows a search field — a list the thumb cannot scan. */
const SEARCH_THRESHOLD = 9;

/** Bottom sheet of options — pickers, and a chat's actions. */
export function OptionSheet({
  open,
  title,
  subtitle,
  groups,
  value,
  onSelect,
  onClose,
}: {
  open: boolean;
  title: string;
  subtitle?: string;
  groups: OptionGroup[];
  value: string | null;
  onSelect: (value: string) => void;
  onClose: () => void;
}): JSX.Element | null {
  const palette = usePalette();
  const { t } = useT();
  const [query, setQuery] = useState("");
  const total = groups.reduce((sum, group) => sum + group.options.length, 0);
  const searchable = total > SEARCH_THRESHOLD;

  useEffect(() => {
    if (open) setQuery("");
  }, [open]);

  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return groups;
    return groups
      .map((group) => ({
        ...group,
        options: group.options.filter((option) => `${option.label} ${option.description ?? ""}`.toLowerCase().includes(needle)),
      }))
      .filter((group) => group.options.length > 0);
  }, [groups, query]);

  return (
    <Sheet open={open} onClose={onClose} title={title} subtitle={subtitle} tall={searchable}>
      {searchable ? (
        <SearchField value={query} onChange={setQuery} placeholder={t("common.search")} palette={palette} style={styles.search} />
      ) : null}
      <ScrollView style={styles.scroll} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled" bounces={false}>
        {shown.length === 0 ? <Text style={[styles.none, { color: palette.muted }]}>{t("common.noMatch")}</Text> : null}
        {shown.map((group, groupIndex) => (
          <View key={`${group.label}-${groupIndex}`} style={styles.group}>
            {group.label ? <Text style={[styles.groupLabel, { color: palette.muted }]}>{group.label}</Text> : null}
            <View style={[styles.card, { backgroundColor: palette.background }]}>
              {group.options.map((option, index) => {
                const selected = option.value === value;
                const color = option.destructive ? palette.danger : palette.text;
                return (
                  <Pressable
                    key={option.value}
                    onPress={() => {
                      haptic.select();
                      onSelect(option.value);
                      onClose();
                    }}
                    style={({ pressed }) => [
                      styles.row,
                      index > 0 ? { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: palette.border } : null,
                      pressed ? { backgroundColor: palette.field } : null,
                    ]}
                  >
                    {option.avatar !== undefined ? <Avatar name={option.avatar} palette={palette} size={30} /> : null}
                    {option.icon ? (
                      <View style={[styles.icon, { backgroundColor: option.destructive ? palette.dangerSoft : palette.card }]}>
                        <HugeiconsIcon icon={option.icon} size={17} color={option.destructive ? palette.danger : palette.text} strokeWidth={1.9} />
                      </View>
                    ) : null}
                    <View style={styles.rowText}>
                      <Text style={[styles.rowLabel, { color, fontWeight: selected ? "600" : "400" }]} numberOfLines={1}>
                        {option.label}
                      </Text>
                      {option.description ? (
                        <Text style={[styles.rowDescription, { color: palette.muted }]} numberOfLines={2}>
                          {option.description}
                        </Text>
                      ) : null}
                    </View>
                    {selected ? <HugeiconsIcon icon={Tick02Icon} size={19} color={palette.accent} strokeWidth={2.4} /> : null}
                  </Pressable>
                );
              })}
            </View>
          </View>
        ))}
      </ScrollView>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  search: { marginHorizontal: 16, marginBottom: 8 },
  scroll: { flexGrow: 0, flexShrink: 1 },
  content: { paddingHorizontal: 16, paddingBottom: 8 },
  group: { marginTop: 6, marginBottom: 8, gap: 6 },
  groupLabel: { fontSize: 13, fontWeight: "600", paddingHorizontal: 6 },
  card: { borderRadius: radius.lg, overflow: "hidden" },
  row: { flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 14, minHeight: 52, paddingVertical: 10 },
  icon: { width: 30, height: 30, borderRadius: 9, alignItems: "center", justifyContent: "center" },
  rowText: { flex: 1, minWidth: 0, gap: 2 },
  rowLabel: { fontSize: 16 },
  rowDescription: { fontSize: 13, lineHeight: 18 },
  none: { textAlign: "center", paddingVertical: 24, fontSize: 14 },
});
