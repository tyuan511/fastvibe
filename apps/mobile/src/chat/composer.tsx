import { useCallback, useEffect, useState, type JSX } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { HugeiconsIcon } from "@hugeicons/react-native";
import Svg, { Circle } from "react-native-svg";
import { AiBrain01Icon, ArrowDown01Icon, ArrowUp02Icon, HandIcon, PlayIcon, ShieldAlertIcon, ShieldCheckIcon, SquareIcon } from "../ui/icons";
import type { IconSvgElement } from "@hugeicons/react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { currentConnection, getClient } from "../session/connection";
import { OptionSheet } from "./option-sheet";
import { ModelPicker, modelKey, type PickerModel } from "./model-picker";
import { loadModelRecents, rememberModel } from "./model-recents";
import { Avatar } from "../ui/kit";
import { Gradient } from "../ui/gradient";
import { dialog } from "../ui/dialog";
import { toast } from "../ui/toast";
import { haptic } from "../ui/haptics";
import { elevation, radius, usePalette, type Palette } from "../ui/theme";
import { t, useT, type MessageKey } from "../i18n";

type EngineModel = { provider: string; id: string };
type ContextUsage = { tokens: number | null; contextWindow: number; percent: number | null };
type SessionState = { model?: EngineModel; thinkingLevel?: string; contextUsage?: ContextUsage };
type Picker = "model" | "thinking" | "permission" | null;

const THINKING_KEYS = ["off", "minimal", "low", "medium", "high", "xhigh", "max", "auto"] as const;
function thinkingLabel(level: string): string {
  return (THINKING_KEYS as readonly string[]).includes(level) ? t(`thinking.${level}` as MessageKey) : level;
}
function thinkingHint(level: string): string | undefined {
  return level !== "off" && level !== "auto" && (THINKING_KEYS as readonly string[]).includes(level) ? t(`thinking.${level}Hint` as MessageKey) : undefined;
}
const PERMISSION_ICON: Record<string, IconSvgElement> = { ask: HandIcon, smart: ShieldAlertIcon, full: ShieldCheckIcon };
const PERMISSION_MODES = ["ask", "smart", "full"] as const;

/** Mobile equivalent of the desktop composer card. */
export function Composer({
  conversationId,
  running,
  sending = false,
  queueing = running,
  disabled,
  draft,
  onDraftChange,
  onSend,
  onAbort,
  onContinue,
  canContinue,
}: {
  conversationId: string;
  running: boolean;
  /** Waiting for direct submission or durable enqueue acknowledgement. */
  sending?: boolean;
  queueing?: boolean;
  disabled: boolean;
  draft: string;
  onDraftChange: (text: string) => void;
  onSend: () => void;
  onAbort: () => void;
  onContinue: () => void;
  canContinue: boolean;
}): JSX.Element {
  const palette = usePalette();
  useT();
  const insets = useSafeAreaInsets();
  const [picker, setPicker] = useState<Picker>(null);
  const [models, setModels] = useState<PickerModel[]>([]);
  const [session, setSession] = useState<SessionState | null>(null);
  const [permissionMode, setPermissionMode] = useState("smart");
  const [fullAccessConfirmed, setFullAccessConfirmed] = useState(false);
  const [recents, setRecents] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [focused, setFocused] = useState(false);
  const serverId = currentConnection().server?.id;

  const refresh = useCallback(async () => {
    const remote = getClient();
    if (!remote) return;
    try {
      const [state, list, settings] = await Promise.all([
        remote.call("engine:get-state", { conversationId }) as Promise<SessionState>,
        remote.call("engine:get-models", { conversationId }) as Promise<PickerModel[]>,
        remote.call("settings:get") as Promise<Record<string, unknown>>,
      ]);
      setSession(state);
      setModels(Array.isArray(list) ? list : []);
      if (settings.permissionMode === "ask" || settings.permissionMode === "smart" || settings.permissionMode === "full") {
        setPermissionMode(settings.permissionMode);
      }
      setFullAccessConfirmed(settings.fullAccessConfirmed === true);
    } catch {
      // The chat connection owns the visible connection error.
    }
  }, [conversationId]);

  // Again when a run settles: the context window only moves while one is in flight.
  useEffect(() => { void refresh(); }, [refresh, running, disabled]);

  useEffect(() => {
    if (!serverId) return;
    void loadModelRecents(serverId).then(setRecents);
  }, [serverId]);

  const currentModel = session?.model;
  const catalog = currentModel ? models.find((item) => item.provider === currentModel.provider && item.id === currentModel.id) : undefined;
  const levels = (catalog?.thinkingLevels ?? []).filter((level) => level !== "off");

  async function chooseModel(model: PickerModel): Promise<void> {
    const remote = getClient();
    const { provider, id: modelId } = model;
    if (!remote || busy) return;
    if (currentModel && currentModel.provider === provider && currentModel.id === modelId) return;
    setBusy(true);
    try {
      let next = (await remote.call("engine:set-model", { provider, modelId, conversationId })) as SessionState;
      const offered = models.find((item) => item.provider === provider && item.id === modelId)?.thinkingLevels?.filter((level) => level !== "off");
      if (offered?.length && (!next.thinkingLevel || !offered.includes(next.thinkingLevel))) {
        next = (await remote.call("engine:set-thinking", { level: offered.includes("high") ? "high" : offered[0], conversationId })) as SessionState;
      }
      setSession((previous) => ({ ...previous, ...next }));
      toast.success(t("toast.modelSwitched", { model: model.name || model.id }));
      if (serverId) setRecents(await rememberModel(serverId, modelKey(model)));
    } catch (error) {
      toast.failure(error, t("composer.modelFailed"));
    } finally {
      setBusy(false);
    }
  }

  async function chooseThinking(level: string): Promise<void> {
    const remote = getClient();
    if (!remote || busy) return;
    setBusy(true);
    try {
      const next = (await remote.call("engine:set-thinking", { level, conversationId })) as SessionState;
      setSession((previous) => ({ ...previous, ...next }));
    } catch (error) {
      toast.failure(error, t("composer.thinkingFailed"));
    } finally {
      setBusy(false);
    }
  }

  async function choosePermission(mode: string): Promise<void> {
    if (mode === "full" && !fullAccessConfirmed) {
      dialog.confirm({
        title: t("composer.fullTitle"),
        message: t("composer.fullBody"),
        confirmLabel: t("composer.enable"),
        destructive: true,
        onConfirm: () => void savePermission(mode, true),
      });
      return;
    }
    await savePermission(mode, false);
  }

  async function savePermission(mode: string, confirmFull: boolean): Promise<void> {
    const remote = getClient();
    if (!remote || busy) return;
    setBusy(true);
    try {
      await remote.call("settings:set", { permissionMode: mode, ...(confirmFull ? { fullAccessConfirmed: true } : {}) });
      setPermissionMode(mode);
      if (confirmFull) setFullAccessConfirmed(true);
    } catch (error) {
      toast.failure(error, t("composer.permissionFailed"));
    } finally {
      setBusy(false);
    }
  }

  const hasContent = draft.trim().length > 0;
  const action = sending ? "sending" : running && !hasContent ? "stop" : canContinue && !hasContent ? "continue" : "send";
  const actionDisabled = disabled || sending || (action === "send" && !hasContent);
  const modelLabel = catalog?.name || currentModel?.id || (models.length === 0 ? t("composer.noModels") : t("composer.defaultModel"));
  const percent = session?.contextUsage?.percent;

  function press(): void {
    if (action === "stop") {
      haptic.press();
      onAbort();
    } else if (action === "continue") {
      haptic.tap();
      onContinue();
    } else {
      haptic.tap();
      onSend();
    }
  }

  return (
    <View style={[styles.outer, { paddingBottom: Math.max(insets.bottom, 10) }]}>
      <View
        style={[
          styles.card,
          // A hint of lift, not a floating slab: the card sits right on the page.
          elevation(palette, 0),
          { backgroundColor: palette.card, borderColor: focused ? palette.accent : palette.border },
        ]}
      >
        <TextInput
          value={draft}
          onChangeText={onDraftChange}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          placeholder={disabled ? t("composer.placeholderLoading") : queueing ? t("composer.placeholderQueue") : t("composer.placeholder")}
          placeholderTextColor={palette.subtle}
          multiline
          editable={!disabled}
          style={[styles.input, { color: palette.text }]}
        />
        <View style={styles.toolbar}>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            keyboardShouldPersistTaps="handled"
            style={styles.chips}
            contentContainerStyle={styles.chipsContent}
          >
            <Chip
              palette={palette}
              label={permissionMode === "ask" || permissionMode === "smart" || permissionMode === "full" ? t(`permission.${permissionMode}`) : permissionMode}
              icon={PERMISSION_ICON[permissionMode] ?? ShieldAlertIcon}
              tone={permissionMode === "full" ? "danger" : "plain"}
              disabled={disabled || busy}
              onPress={() => setPicker("permission")}
            />
            <Chip
              palette={palette}
              label={modelLabel}
              avatar={catalog?.providerName ?? currentModel?.provider}
              disabled={disabled || busy || models.length === 0}
              onPress={() => setPicker("model")}
            />
            {levels.length > 0 ? (
              <Chip
                palette={palette}
                label={session?.thinkingLevel ? thinkingLabel(session.thinkingLevel) : t("composer.thinkingChip")}
                icon={AiBrain01Icon}
                disabled={disabled || busy}
                onPress={() => setPicker("thinking")}
              />
            ) : null}
          </ScrollView>
          {busy ? <ActivityIndicator size="small" color={palette.muted} style={styles.busy} /> : null}
          {typeof percent === "number" ? <ContextRing percent={percent} palette={palette} usage={session?.contextUsage} /> : null}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t(action === "sending" ? "composer.sending" : action === "stop" ? "composer.stop" : action === "continue" ? "composer.continue" : queueing ? "composer.enqueue" : "composer.send")}
            accessibilityState={{ busy: sending, disabled: actionDisabled }}
            onPress={press}
            disabled={actionDisabled}
            hitSlop={6}
            style={({ pressed }) => [{ opacity: actionDisabled ? 0.35 : 1, transform: [{ scale: pressed ? 0.92 : 1 }] }]}
          >
            {action === "stop" ? (
              <View style={[styles.action, { backgroundColor: palette.text }]}>
                <HugeiconsIcon icon={SquareIcon} size={14} color={palette.card} strokeWidth={2.6} />
              </View>
            ) : (
              <Gradient colors={actionDisabled ? [palette.subtle, palette.subtle] : palette.brand} radius={18} style={styles.action}>
                {sending ? (
                  <ActivityIndicator size="small" color="#ffffff" />
                ) : (
                  <HugeiconsIcon icon={action === "continue" ? PlayIcon : ArrowUp02Icon} size={18} color="#ffffff" strokeWidth={2.4} />
                )}
              </Gradient>
            )}
          </Pressable>
        </View>
      </View>

      <ModelPicker
        open={picker === "model"}
        models={models}
        current={currentModel}
        recents={recents}
        onSelect={(model) => void chooseModel(model)}
        onClose={() => setPicker(null)}
      />
      <OptionSheet
        open={picker === "thinking"}
        title={t("composer.thinkingTitle")}
        subtitle={catalog?.name}
        groups={[{ label: "", options: levels.map((level) => ({ value: level, label: thinkingLabel(level), description: thinkingHint(level) })) }]}
        value={session?.thinkingLevel ?? null}
        onSelect={(value) => void chooseThinking(value)}
        onClose={() => setPicker(null)}
      />
      <OptionSheet
        open={picker === "permission"}
        title={t("composer.permissionTitle")}
        subtitle={t("composer.permissionScope")}
        groups={[{ label: "", options: PERMISSION_MODES.map((mode) => ({ value: mode, label: t(`permission.${mode}`), description: t(`permission.${mode}Hint`), icon: PERMISSION_ICON[mode], destructive: mode === "full" })) }]}
        value={permissionMode}
        onSelect={(value) => void choosePermission(value)}
        onClose={() => setPicker(null)}
      />
    </View>
  );
}

/** How full the context window is: a ring that turns amber past 70% and red past 90%. */
function ContextRing({ percent, palette, usage }: { percent: number; palette: Palette; usage?: ContextUsage }): JSX.Element {
  const size = 22;
  const stroke = 2.6;
  const r = (size - stroke) / 2;
  const circumference = 2 * Math.PI * r;
  const clamped = Math.max(0, Math.min(100, percent));
  const color = clamped >= 90 ? palette.danger : clamped >= 70 ? palette.warning : palette.accent;
  return (
    <Pressable
      hitSlop={8}
      accessibilityLabel={t("composer.contextUsed", { percent: Math.round(clamped) })}
      onPress={() => {
        const detail = usage?.tokens != null
          ? `${formatTokens(usage.tokens)} / ${formatTokens(usage.contextWindow)} tokens`
          : t("composer.contextWindow", { window: formatTokens(usage?.contextWindow ?? 0) });
        dialog.alert(t("composer.contextUsed", { percent: Math.round(clamped) }), t("composer.contextNote", { detail }));
      }}
      style={styles.ring}
    >
      <Svg width={size} height={size}>
        <Circle cx={size / 2} cy={size / 2} r={r} stroke={palette.field} strokeWidth={stroke} fill="none" />
        <Circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          stroke={color}
          strokeWidth={stroke}
          fill="none"
          strokeLinecap="round"
          strokeDasharray={`${circumference} ${circumference}`}
          strokeDashoffset={circumference * (1 - clamped / 100)}
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
        />
      </Svg>
    </Pressable>
  );
}

function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${Math.round(value / 1_000)}K`;
  return String(value);
}

function Chip({
  label,
  icon,
  avatar,
  tone = "plain",
  disabled,
  onPress,
  palette,
}: {
  label: string;
  icon?: IconSvgElement;
  avatar?: string;
  tone?: "plain" | "danger";
  disabled?: boolean;
  onPress: () => void;
  palette: Palette;
}): JSX.Element {
  const color = tone === "danger" ? palette.danger : palette.text;
  return (
    <Pressable
      onPress={() => {
        haptic.select();
        onPress();
      }}
      disabled={disabled}
      style={({ pressed }) => [
        styles.chip,
        { backgroundColor: tone === "danger" ? palette.dangerSoft : palette.field, opacity: disabled ? 0.45 : pressed ? 0.7 : 1 },
      ]}
    >
      {avatar ? <Avatar name={avatar} palette={palette} size={18} /> : null}
      {icon ? <HugeiconsIcon icon={icon} size={14} color={tone === "danger" ? palette.danger : palette.muted} strokeWidth={2} /> : null}
      <Text style={[styles.chipLabel, { color }]} numberOfLines={1}>{label}</Text>
      <HugeiconsIcon icon={ArrowDown01Icon} size={12} color={palette.subtle} strokeWidth={2.2} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  outer: { paddingHorizontal: 10, paddingTop: 6 },
  card: { borderRadius: radius.xl, borderWidth: StyleSheet.hairlineWidth, paddingBottom: 8 },
  input: { minHeight: 48, maxHeight: 150, paddingHorizontal: 16, paddingTop: 13, paddingBottom: 6, fontSize: 16, lineHeight: 22 },
  toolbar: { flexDirection: "row", alignItems: "center", gap: 6, paddingLeft: 8, paddingRight: 8 },
  chips: { flex: 1 },
  chipsContent: { gap: 6, alignItems: "center", paddingRight: 4 },
  chip: { flexDirection: "row", alignItems: "center", gap: 5, maxWidth: 190, height: 30, borderRadius: radius.pill, paddingHorizontal: 10 },
  chipLabel: { fontSize: 13, fontWeight: "600", flexShrink: 1 },
  busy: { marginHorizontal: 2 },
  ring: { width: 28, height: 28, alignItems: "center", justifyContent: "center" },
  action: { width: 36, height: 36, borderRadius: 18, alignItems: "center", justifyContent: "center" },
});
