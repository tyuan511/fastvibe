import type { JSX, ReactNode } from "react";
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
  type StyleProp,
  type TextInputProps,
  type ViewStyle,
} from "react-native";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react-native";
import { Cancel01Icon, Search01Icon } from "./icons";
import { Gradient } from "./gradient";
import { initials, nameTint, radius, type Palette } from "./theme";
import { t } from "../i18n";

/** A round icon-only control; `tone` picks the fill. */
export function IconButton({
  icon,
  onPress,
  palette,
  label,
  tone = "plain",
  size = 36,
  disabled,
}: {
  icon: IconSvgElement;
  onPress: () => void;
  palette: Palette;
  label: string;
  tone?: "plain" | "field" | "accent" | "soft";
  size?: number;
  disabled?: boolean;
}): JSX.Element {
  const fill = tone === "field" ? palette.field : tone === "accent" ? palette.accent : tone === "soft" ? palette.accentSoft : "transparent";
  const color = tone === "accent" ? palette.accentText : tone === "soft" ? palette.accent : palette.text;
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      hitSlop={6}
      style={({ pressed }) => [
        { width: size, height: size, borderRadius: size / 2, backgroundColor: fill, alignItems: "center", justifyContent: "center" },
        { opacity: disabled ? 0.4 : pressed ? 0.6 : 1 },
      ]}
    >
      <HugeiconsIcon icon={icon} size={Math.round(size * 0.52)} color={color} strokeWidth={1.9} />
    </Pressable>
  );
}

/** A name's coloured initial — for a provider or a project, never a person. */
export function Avatar({
  name,
  palette,
  size = 32,
  icon,
  style,
}: {
  name: string;
  palette: Palette;
  size?: number;
  icon?: IconSvgElement;
  style?: StyleProp<ViewStyle>;
}): JSX.Element {
  const tint = nameTint(name, palette);
  return (
    <View
      style={[
        { width: size, height: size, borderRadius: size * 0.3, backgroundColor: tint.bg, alignItems: "center", justifyContent: "center" },
        style,
      ]}
    >
      {icon ? (
        <HugeiconsIcon icon={icon} size={Math.round(size * 0.52)} color={tint.fg} strokeWidth={1.9} />
      ) : (
        <Text style={{ color: tint.fg, fontSize: Math.round(size * 0.42), fontWeight: "700" }}>{initials(name)}</Text>
      )}
    </View>
  );
}

export function Pill({
  label,
  palette,
  tone = "neutral",
  icon,
}: {
  label: string;
  palette: Palette;
  tone?: "neutral" | "accent" | "warning" | "danger" | "success";
  icon?: IconSvgElement;
}): JSX.Element {
  const [fg, bg] =
    tone === "accent" ? [palette.accent, palette.accentSoft]
      : tone === "warning" ? [palette.warning, palette.warningSoft]
        : tone === "danger" ? [palette.danger, palette.dangerSoft]
          : tone === "success" ? [palette.success, palette.successSoft]
            : [palette.muted, palette.field];
  return (
    <View style={[styles.pill, { backgroundColor: bg }]}>
      {icon ? <HugeiconsIcon icon={icon} size={11} color={fg} strokeWidth={2.2} /> : null}
      <Text style={[styles.pillText, { color: fg }]} numberOfLines={1}>{label}</Text>
    </View>
  );
}

export function SearchField({
  value,
  onChange,
  placeholder,
  palette,
  style,
  ...rest
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  palette: Palette;
  style?: StyleProp<ViewStyle>;
} & Omit<TextInputProps, "value" | "onChange" | "onChangeText" | "placeholder" | "style">): JSX.Element {
  return (
    <View style={[styles.search, { backgroundColor: palette.field }, style]}>
      <HugeiconsIcon icon={Search01Icon} size={17} color={palette.muted} strokeWidth={2} />
      <TextInput
        value={value}
        onChangeText={onChange}
        placeholder={placeholder}
        placeholderTextColor={palette.subtle}
        returnKeyType="search"
        autoCorrect={false}
        autoCapitalize="none"
        style={[styles.searchInput, { color: palette.text }]}
        {...rest}
      />
      {value ? (
        <Pressable onPress={() => onChange("")} hitSlop={10} accessibilityLabel={t("common.clearSearch")}>
          <View style={[styles.clear, { backgroundColor: palette.subtle }]}>
            <HugeiconsIcon icon={Cancel01Icon} size={10} color={palette.card} strokeWidth={3} />
          </View>
        </Pressable>
      ) : null}
    </View>
  );
}

/** The one filled call to action on a screen, drawn in the icon's gradient. */
export function PrimaryButton({
  label,
  onPress,
  palette,
  icon,
  busy,
  disabled,
  style,
}: {
  label: string;
  onPress: () => void;
  palette: Palette;
  icon?: IconSvgElement;
  busy?: boolean;
  disabled?: boolean;
  style?: StyleProp<ViewStyle>;
}): JSX.Element {
  const off = disabled || busy;
  return (
    <Pressable
      onPress={onPress}
      disabled={off}
      accessibilityRole="button"
      accessibilityState={{ disabled: off, busy }}
      style={({ pressed }) => [{ opacity: disabled ? 0.45 : pressed ? 0.85 : 1, transform: [{ scale: pressed ? 0.985 : 1 }] }, style]}
    >
      <Gradient colors={palette.brand} radius={radius.md} style={styles.primary}>
        {busy ? (
          <ActivityIndicator color="#ffffff" />
        ) : (
          <>
            {icon ? <HugeiconsIcon icon={icon} size={19} color="#ffffff" strokeWidth={2} /> : null}
            <Text style={styles.primaryLabel}>{label}</Text>
          </>
        )}
      </Gradient>
    </Pressable>
  );
}

export function SecondaryButton({
  label,
  onPress,
  palette,
  icon,
  disabled,
  style,
}: {
  label: string;
  onPress: () => void;
  palette: Palette;
  icon?: IconSvgElement;
  disabled?: boolean;
  style?: StyleProp<ViewStyle>;
}): JSX.Element {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      style={({ pressed }) => [
        styles.secondary,
        { backgroundColor: palette.card, borderColor: palette.border, opacity: disabled ? 0.45 : pressed ? 0.7 : 1 },
        style,
      ]}
    >
      {icon ? <HugeiconsIcon icon={icon} size={19} color={palette.accent} strokeWidth={2} /> : null}
      <Text style={[styles.secondaryLabel, { color: palette.text }]}>{label}</Text>
    </Pressable>
  );
}

export function SectionLabel({ title, count, palette, right }: { title: string; count?: number; palette: Palette; right?: ReactNode }): JSX.Element {
  return (
    <View style={styles.section}>
      <Text style={[styles.sectionTitle, { color: palette.muted }]}>{title}</Text>
      {count !== undefined ? <Text style={[styles.sectionCount, { color: palette.subtle }]}>{count}</Text> : null}
      <View style={{ flex: 1 }} />
      {right}
    </View>
  );
}

export function EmptyState({
  icon,
  title,
  body,
  palette,
  children,
}: {
  icon: IconSvgElement;
  title: string;
  body?: string;
  palette: Palette;
  children?: ReactNode;
}): JSX.Element {
  return (
    <View style={styles.empty}>
      <View style={[styles.emptyIcon, { backgroundColor: palette.accentSoft }]}>
        <HugeiconsIcon icon={icon} size={28} color={palette.accent} strokeWidth={1.8} />
      </View>
      <Text style={[styles.emptyTitle, { color: palette.text }]}>{title}</Text>
      {body ? <Text style={[styles.emptyBody, { color: palette.muted }]}>{body}</Text> : null}
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  pill: { flexDirection: "row", alignItems: "center", gap: 3, borderRadius: radius.pill, paddingHorizontal: 7, paddingVertical: 2, maxWidth: 160 },
  pillText: { fontSize: 11, fontWeight: "600" },
  search: { flexDirection: "row", alignItems: "center", gap: 8, height: 40, borderRadius: radius.md, paddingHorizontal: 12 },
  searchInput: { flex: 1, height: 40, fontSize: 16, paddingVertical: 0 },
  clear: { width: 16, height: 16, borderRadius: 8, alignItems: "center", justifyContent: "center" },
  primary: { height: 50, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, paddingHorizontal: 20 },
  primaryLabel: { color: "#ffffff", fontSize: 16, fontWeight: "700", letterSpacing: 0.2 },
  secondary: { height: 50, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, paddingHorizontal: 20, borderRadius: radius.md, borderWidth: StyleSheet.hairlineWidth },
  secondaryLabel: { fontSize: 16, fontWeight: "600" },
  section: { flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 4, paddingTop: 14, paddingBottom: 6 },
  sectionTitle: { fontSize: 13, fontWeight: "700", letterSpacing: 0.2 },
  sectionCount: { fontSize: 12, fontWeight: "600", fontVariant: ["tabular-nums"] },
  empty: { alignItems: "center", paddingHorizontal: 32, paddingVertical: 40, gap: 8 },
  emptyIcon: { width: 60, height: 60, borderRadius: 20, alignItems: "center", justifyContent: "center", marginBottom: 6 },
  emptyTitle: { fontSize: 17, fontWeight: "700", textAlign: "center" },
  emptyBody: { fontSize: 14, lineHeight: 21, textAlign: "center" },
});
