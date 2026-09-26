import { useEffect, useMemo, useState, type JSX } from "react";
import { FlatList, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { HugeiconsIcon } from "@hugeicons/react-native";
import { AiBrain01Icon, ArrowDown01Icon, Clock01Icon, Tick02Icon } from "../ui/icons";
import { Sheet } from "../ui/sheet";
import { Avatar, SearchField } from "../ui/kit";
import { haptic } from "../ui/haptics";
import { radius, usePalette, type Palette } from "../ui/theme";
import { t, useT } from "../i18n";

export type PickerModel = { provider: string; providerName: string; id: string; name: string; thinkingLevels?: string[] };

export function modelKey(model: { provider: string; id: string }): string {
  return `${model.provider}\u0000${model.id}`;
}

/** 全部 / 最近 / one provider — what the rail above the list narrows to. */
type Scope = { kind: "all" } | { kind: "recent" } | { kind: "provider"; provider: string };

type Row =
  | { kind: "header"; key: string; provider: string; name: string; count: number; open: boolean; current: boolean }
  | { kind: "label"; key: string; title: string }
  | { kind: "model"; key: string; model: PickerModel; showProvider: boolean; last: boolean; first: boolean };

/**
 * The model picker, built for an install with many providers.
 *
 * A flat list of every provider's every model was a scroll of several screens to reach
 * the one the user wanted, so the list is shaped around the three ways people actually
 * find a model: by name (the search field, across every provider at once), by provider
 * (the rail — one tap narrows to it), and by habit (最近, the ones this phone picked
 * last). With neither a query nor a provider chosen, each provider is one collapsed
 * row and only the current model's provider is open, so the sheet opens to a list
 * about as long as the number of providers rather than the number of models.
 */
export function ModelPicker({
  open,
  models,
  current,
  recents,
  onSelect,
  onClose,
}: {
  open: boolean;
  models: PickerModel[];
  current?: { provider: string; id: string };
  recents: string[];
  onSelect: (model: PickerModel) => void;
  onClose: () => void;
}): JSX.Element | null {
  const palette = usePalette();
  const { language } = useT();
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState<Scope>({ kind: "all" });
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const providers = useMemo(() => {
    const map = new Map<string, { provider: string; name: string; models: PickerModel[] }>();
    for (const model of models) {
      const entry = map.get(model.provider) ?? { provider: model.provider, name: model.providerName || model.provider, models: [] };
      entry.models.push(model);
      map.set(model.provider, entry);
    }
    return [...map.values()];
  }, [models]);

  const byKey = useMemo(() => new Map(models.map((model) => [modelKey(model), model])), [models]);
  const recentModels = useMemo(
    () => recents.map((key) => byKey.get(key)).filter((model): model is PickerModel => Boolean(model)),
    [recents, byKey],
  );
  // Few enough models that collapsing would hide more than it saves.
  const small = models.length <= 14 || providers.length <= 1;

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setScope({ kind: "all" });
    setExpanded(new Set(current ? [current.provider] : []));
  }, [open, current]);

  const rows = useMemo<Row[]>(() => {
    const needle = query.trim().toLowerCase();
    const out: Row[] = [];
    const pushModels = (list: PickerModel[], showProvider: boolean, prefix: string) => {
      list.forEach((model, index) =>
        out.push({ kind: "model", key: `${prefix}${modelKey(model)}`, model, showProvider, first: index === 0, last: index === list.length - 1 }),
      );
    };
    if (needle) {
      const terms = needle.split(/\s+/).filter(Boolean);
      for (const entry of providers) {
        if (scope.kind === "provider" && scope.provider !== entry.provider) continue;
        const matches = entry.models.filter((model) => {
          const haystack = `${model.name} ${model.id} ${entry.name}`.toLowerCase();
          return terms.every((term) => haystack.includes(term));
        });
        if (matches.length === 0) continue;
        out.push({ kind: "label", key: `l-${entry.provider}`, title: entry.name });
        pushModels(matches, false, "q-");
      }
      return out;
    }
    if (scope.kind === "recent") {
      pushModels(recentModels, true, "r-");
      return out;
    }
    if (scope.kind === "provider") {
      pushModels(providers.find((entry) => entry.provider === scope.provider)?.models ?? [], false, "p-");
      return out;
    }
    if (recentModels.length > 0 && !small) {
      out.push({ kind: "label", key: "l-recent", title: t("models.recentlyUsed") });
      pushModels(recentModels.slice(0, 3), true, "r-");
    }
    if (!small) out.push({ kind: "label", key: "l-providers", title: t("models.allProviders") });
    for (const entry of providers) {
      const isOpen = small || expanded.has(entry.provider);
      if (!small || providers.length > 1) {
        out.push({
          kind: "header",
          key: `h-${entry.provider}`,
          provider: entry.provider,
          name: entry.name,
          count: entry.models.length,
          open: isOpen,
          current: current?.provider === entry.provider,
        });
      }
      if (isOpen) pushModels(entry.models, false, `m-`);
    }
    return out;
  }, [query, scope, providers, recentModels, expanded, small, current, language]);

  function pick(model: PickerModel): void {
    haptic.select();
    onSelect(model);
    onClose();
  }

  function toggle(provider: string): void {
    haptic.tap();
    setExpanded((previous) => {
      const next = new Set(previous);
      if (next.has(provider)) next.delete(provider);
      else next.add(provider);
      return next;
    });
  }

  const currentKey = current ? modelKey(current) : null;
  const grouped = rows.some((row) => row.kind === "header");

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={t("models.title")}
      subtitle={t("models.summary", { models: models.length, providers: providers.length })}
      tall
    >
      <SearchField value={query} onChange={setQuery} placeholder={t("models.search")} palette={palette} style={styles.search} />
      {providers.length > 1 ? (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={styles.rail}
          contentContainerStyle={styles.railContent}
          keyboardShouldPersistTaps="handled"
        >
          <RailChip label={t("models.all")} active={scope.kind === "all"} palette={palette} onPress={() => setScope({ kind: "all" })} />
          {recentModels.length > 0 ? (
            <RailChip label={t("models.recent")} icon active={scope.kind === "recent"} palette={palette} onPress={() => setScope({ kind: "recent" })} />
          ) : null}
          {providers.map((entry) => (
            <RailChip
              key={entry.provider}
              label={entry.name}
              avatar
              count={entry.models.length}
              active={scope.kind === "provider" && scope.provider === entry.provider}
              palette={palette}
              onPress={() => setScope({ kind: "provider", provider: entry.provider })}
            />
          ))}
        </ScrollView>
      ) : null}
      <FlatList
        data={rows}
        keyExtractor={(row) => row.key}
        style={styles.list}
        contentContainerStyle={styles.listContent}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        initialNumToRender={24}
        ListEmptyComponent={
          <Text style={[styles.none, { color: palette.muted }]}>
            {query ? t("models.noMatch") : scope.kind === "recent" ? t("models.noRecent") : t("models.none")}
          </Text>
        }
        renderItem={({ item }) => {
          if (item.kind === "label") return <Text style={[styles.label, { color: palette.muted }]}>{item.title}</Text>;
          if (item.kind === "header") {
            return (
              <Pressable
                onPress={() => toggle(item.provider)}
                style={({ pressed }) => [
                  styles.header,
                  { backgroundColor: pressed ? palette.field : palette.background },
                  item.open ? styles.headerOpen : null,
                ]}
              >
                <Avatar name={item.name} palette={palette} size={30} />
                <View style={styles.headerText}>
                  <Text style={[styles.headerName, { color: palette.text }]} numberOfLines={1}>{item.name}</Text>
                  <Text style={[styles.headerMeta, { color: palette.muted }]}>
                    {t("models.count", { count: item.count })}{item.current ? t("models.current") : ""}
                  </Text>
                </View>
                <View style={item.open ? styles.chevronOpen : styles.chevronClosed}>
                  <HugeiconsIcon icon={ArrowDown01Icon} size={18} color={palette.muted} strokeWidth={2} />
                </View>
              </Pressable>
            );
          }
          const selected = modelKey(item.model) === currentKey;
          return (
            <ModelRow
              model={item.model}
              selected={selected}
              showProvider={item.showProvider}
              palette={palette}
              first={item.first}
              last={item.last}
              attached={grouped && !item.showProvider}
              onPress={() => pick(item.model)}
            />
          );
        }}
      />
    </Sheet>
  );
}

function RailChip({
  label,
  active,
  palette,
  onPress,
  avatar,
  icon,
  count,
}: {
  label: string;
  active: boolean;
  palette: Palette;
  onPress: () => void;
  avatar?: boolean;
  icon?: boolean;
  count?: number;
}): JSX.Element {
  return (
    <Pressable
      onPress={() => {
        haptic.select();
        onPress();
      }}
      style={({ pressed }) => [
        styles.chip,
        {
          backgroundColor: active ? palette.accentSoft : palette.field,
          borderColor: active ? palette.accent : "transparent",
          opacity: pressed ? 0.7 : 1,
        },
      ]}
    >
      {avatar ? <Avatar name={label} palette={palette} size={20} /> : null}
      {icon ? <HugeiconsIcon icon={Clock01Icon} size={14} color={active ? palette.accent : palette.muted} strokeWidth={2} /> : null}
      <Text style={[styles.chipLabel, { color: active ? palette.accent : palette.text }]} numberOfLines={1}>
        {label}
      </Text>
      {count !== undefined ? <Text style={[styles.chipCount, { color: active ? palette.accent : palette.subtle }]}>{count}</Text> : null}
    </Pressable>
  );
}

function ModelRow({
  model,
  selected,
  showProvider,
  palette,
  first,
  last,
  attached,
  onPress,
}: {
  model: PickerModel;
  selected: boolean;
  showProvider: boolean;
  palette: Palette;
  first: boolean;
  last: boolean;
  /** Sits directly under its provider's header, as one card with it. */
  attached: boolean;
  onPress: () => void;
}): JSX.Element {
  const name = model.name || model.id;
  const reasons = (model.thinkingLevels ?? []).some((level) => level !== "off");
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [
        styles.row,
        { backgroundColor: selected ? palette.accentSoft : pressed ? palette.field : palette.background },
        first && !attached ? styles.rowFirst : null,
        last ? styles.rowLast : null,
        !first || attached ? { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: palette.border } : null,
      ]}
    >
      {showProvider ? <Avatar name={model.providerName || model.provider} palette={palette} size={28} /> : null}
      <View style={styles.rowText}>
        <Text style={[styles.rowName, { color: selected ? palette.accent : palette.text, fontWeight: selected ? "700" : "500" }]} numberOfLines={1}>
          {name}
        </Text>
        <Text style={[styles.rowId, { color: palette.muted }]} numberOfLines={1} ellipsizeMode="middle">
          {showProvider ? `${model.providerName || model.provider} · ${model.id}` : model.id}
        </Text>
      </View>
      {reasons ? (
        <View style={[styles.badge, { backgroundColor: palette.card }]}>
          <HugeiconsIcon icon={AiBrain01Icon} size={12} color={palette.muted} strokeWidth={2} />
          <Text style={[styles.badgeText, { color: palette.muted }]}>{t("models.reasoning")}</Text>
        </View>
      ) : null}
      {selected ? <HugeiconsIcon icon={Tick02Icon} size={19} color={palette.accent} strokeWidth={2.4} /> : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  search: { marginHorizontal: 16, marginTop: 4 },
  rail: { flexGrow: 0, marginTop: 10 },
  railContent: { paddingHorizontal: 16, gap: 8 },
  chip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    height: 34,
    borderRadius: radius.pill,
    paddingLeft: 7,
    paddingRight: 12,
    borderWidth: 1,
    maxWidth: 200,
  },
  chipLabel: { fontSize: 14, fontWeight: "600", paddingLeft: 3, flexShrink: 1 },
  chipCount: { fontSize: 12, fontWeight: "600", fontVariant: ["tabular-nums"] },
  list: { flex: 1, marginTop: 6 },
  listContent: { paddingHorizontal: 16, paddingBottom: 20 },
  label: { fontSize: 13, fontWeight: "700", paddingHorizontal: 6, paddingTop: 14, paddingBottom: 6 },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: radius.lg,
    marginTop: 8,
  },
  headerOpen: { borderBottomLeftRadius: 0, borderBottomRightRadius: 0 },
  headerText: { flex: 1, minWidth: 0, gap: 1 },
  headerName: { fontSize: 16, fontWeight: "600" },
  headerMeta: { fontSize: 12 },
  chevronOpen: { transform: [{ rotate: "180deg" }] },
  chevronClosed: {},
  row: { flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 14, paddingVertical: 10, minHeight: 54 },
  rowFirst: { borderTopLeftRadius: radius.lg, borderTopRightRadius: radius.lg },
  rowLast: { borderBottomLeftRadius: radius.lg, borderBottomRightRadius: radius.lg },
  rowText: { flex: 1, minWidth: 0, gap: 2 },
  rowName: { fontSize: 15 },
  rowId: { fontSize: 12, fontFamily: "monospace" },
  badge: { flexDirection: "row", alignItems: "center", gap: 3, borderRadius: radius.pill, paddingHorizontal: 7, paddingVertical: 3 },
  badgeText: { fontSize: 11, fontWeight: "600" },
  none: { textAlign: "center", paddingVertical: 32, paddingHorizontal: 24, fontSize: 14, lineHeight: 20 },
});
