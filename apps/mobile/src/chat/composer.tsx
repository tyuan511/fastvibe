import { memo, useCallback, useEffect, useMemo, useRef, useState, type JSX } from "react";
import { invalidateModelCatalog, readModelCatalog } from "../protocol/model-cache";
import { ActivityIndicator, Image, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import * as ImagePicker from "expo-image-picker";
import { HugeiconsIcon } from "@hugeicons/react-native";
import Svg, { Circle } from "react-native-svg";
import { AiBrain01Icon, ArrowDown01Icon, ArrowUp02Icon, Cancel01Icon, ImageAdd01Icon, PlayIcon, SquareIcon } from "../ui/icons";
import type { IconSvgElement } from "@hugeicons/react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { getClient, useConnection } from "../session/connection";
import { OptionSheet } from "./option-sheet";
import { ModelPicker, modelKey, type PickerModel } from "./model-picker";
import { loadModelRecents, rememberModel } from "./model-recents";
import { Avatar, IconButton } from "../ui/kit";
import { Gradient } from "../ui/gradient";
import { dialog } from "../ui/dialog";
import { toast } from "../ui/toast";
import { haptic } from "../ui/haptics";
import { elevation, radius, usePalette, type Palette } from "../ui/theme";
import { t, useT, type MessageKey } from "../i18n";
import { MAX_COMPOSER_IMAGES, preparePickedImage, type ComposerImage } from "./images";

type EngineModel = { provider: string; id: string };
type ContextUsage = { tokens: number | null; contextWindow: number; percent: number | null };
type SessionState = { model?: EngineModel; thinkingLevel?: string; contextUsage?: ContextUsage };
type Picker = "model" | "thinking" | null;

const THINKING_KEYS = ["off", "minimal", "low", "medium", "high", "xhigh", "max", "auto"] as const;
function thinkingLabel(level: string): string {
  return (THINKING_KEYS as readonly string[]).includes(level) ? t(`thinking.${level}` as MessageKey) : level;
}
function thinkingHint(level: string): string | undefined {
  return level !== "off" && level !== "auto" && (THINKING_KEYS as readonly string[]).includes(level) ? t(`thinking.${level}Hint` as MessageKey) : undefined;
}

/** Mobile equivalent of the desktop composer card. */
export const Composer = memo(function Composer({
  conversationId,
  running,
  sending = false,
  queueing = running,
  disabled,
  draft,
  images,
  onImagesChange,
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
  images: ComposerImage[];
  onImagesChange: (images: ComposerImage[]) => void;
  onDraftChange: (text: string) => void;
  onSend: () => void;
  onAbort: () => void;
  onContinue: () => void;
  canContinue: boolean;
}): JSX.Element {
  const palette = usePalette();
  useT();
  const insets = useSafeAreaInsets();
  const connection = useConnection();
  const refreshVersion = useRef(0);
  const [picker, setPicker] = useState<Picker>(null);
  const [models, setModels] = useState<PickerModel[]>([]);
  const [session, setSession] = useState<SessionState | null>(null);
  const [recents, setRecents] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [imageBusy, setImageBusy] = useState(false);
  const [focused, setFocused] = useState(false);
  const serverId = connection.server?.id;
  const remote = getClient();
  const scope = useMemo(() => ({ remote, conversationId }), [remote, conversationId]);
  const liveScope = useRef(scope);
  liveScope.current = scope;

  useEffect(() => { setSession(null); setBusy(false); }, [scope]);
  useEffect(() => { setModels([]); }, [remote]);

  const refresh = useCallback(async () => {
    if (!remote) return;
    const version = ++refreshVersion.current;
    const current = () => liveScope.current === scope && getClient() === remote && version === refreshVersion.current;
    try {
      await Promise.all([
        remote.call("engine:get-state", { conversationId }).then((value) => { if (current()) setSession(value as SessionState); }),
        readModelCatalog(remote).then((list) => { if (current()) setModels(list as PickerModel[]); }),
      ]);
    } catch {
      // The chat connection owns the visible connection error.
    }
  }, [conversationId, remote, scope]);

  // Again when a run settles: the context window only moves while one is in flight.
  useEffect(() => {
    void refresh();
    return () => { refreshVersion.current += 1; };
  }, [refresh, running]);

  useEffect(() => {
    if (picker !== "model" || !remote) return;
    invalidateModelCatalog(remote);
    void refresh();
  }, [picker, remote, refresh]);

  useEffect(() => {
    if (!serverId) return;
    let active = true;
    void loadModelRecents(serverId).then((value) => { if (active) setRecents(value); });
    return () => { active = false; };
  }, [serverId]);

  const currentModel = session?.model;
  const catalog = currentModel ? models.find((item) => item.provider === currentModel.provider && item.id === currentModel.id) : undefined;
  const levels = (catalog?.thinkingLevels ?? []).filter((level) => level !== "off");

  async function chooseModel(model: PickerModel): Promise<void> {
    const remote = getClient();
    const { provider, id: modelId } = model;
    if (!remote || busy) return;
    if (currentModel && currentModel.provider === provider && currentModel.id === modelId) return;
    refreshVersion.current += 1;
    setBusy(true);
    try {
      let next = (await remote.call("engine:set-model", { provider, modelId, conversationId })) as SessionState;
      if (liveScope.current !== scope || getClient() !== remote) return;
      const offered = models.find((item) => item.provider === provider && item.id === modelId)?.thinkingLevels?.filter((level) => level !== "off");
      if (offered?.length && (!next.thinkingLevel || !offered.includes(next.thinkingLevel))) {
        next = (await remote.call("engine:set-thinking", { level: offered.includes("high") ? "high" : offered[0], conversationId })) as SessionState;
      }
      if (liveScope.current !== scope || getClient() !== remote) return;
      refreshVersion.current += 1;
      setSession((previous) => ({ ...previous, ...next }));
      toast.success(t("toast.modelSwitched", { model: model.name || model.id }));
      if (serverId) {
        const recent = await rememberModel(serverId, modelKey(model));
        if (liveScope.current === scope) setRecents(recent);
      }
    } catch (error) {
      if (liveScope.current === scope) toast.failure(error, t("composer.modelFailed"));
    } finally {
      if (liveScope.current === scope) setBusy(false);
    }
  }

  async function chooseThinking(level: string): Promise<void> {
    const remote = getClient();
    if (!remote || busy) return;
    refreshVersion.current += 1;
    setBusy(true);
    try {
      const next = (await remote.call("engine:set-thinking", { level, conversationId })) as SessionState;
      if (liveScope.current !== scope || getClient() !== remote) return;
      refreshVersion.current += 1;
      setSession((previous) => ({ ...previous, ...next }));
    } catch (error) {
      if (liveScope.current === scope) toast.failure(error, t("composer.thinkingFailed"));
    } finally {
      if (liveScope.current === scope) setBusy(false);
    }
  }

  async function addImages(next: ComposerImage[]): Promise<void> {
    if (next.length === 0) return;
    const combined = [...images, ...next].slice(0, MAX_COMPOSER_IMAGES);
    onImagesChange(combined);
    if (images.length + next.length > MAX_COMPOSER_IMAGES) toast.info(t("composer.imageLimit"));
  }

  async function pickImages(): Promise<void> {
    if (disabled || imageBusy || images.length >= MAX_COMPOSER_IMAGES) return;
    setImageBusy(true);
    try {
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ["images"],
        allowsMultipleSelection: true,
        selectionLimit: MAX_COMPOSER_IMAGES - images.length,
        orderedSelection: true,
        quality: 0.8,
        exif: false,
      });
      if (result.canceled) return;
      const prepared: ComposerImage[] = [];
      for (const asset of result.assets) {
        try {
          prepared.push(await preparePickedImage(asset));
        } catch (error) {
          toast.failure(imageError(error), t("composer.imageFailed"));
        }
      }
      await addImages(prepared);
    } catch (error) {
      toast.failure(imageError(error), t("composer.imageFailed"));
    } finally {
      setImageBusy(false);
    }
  }

  const hasContent = draft.trim().length > 0 || images.length > 0;
  const action = sending ? "sending" : running && !hasContent ? "stop" : canContinue && !hasContent ? "continue" : "send";
  const actionDisabled = disabled || sending || imageBusy || (action === "send" && !hasContent);
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
        {images.length > 0 ? (
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.attachments}>
            {images.map((image) => (
              <View key={image.id} style={[styles.attachment, { borderColor: palette.border, backgroundColor: palette.field }]}>
                <Image source={{ uri: image.uri }} style={styles.attachmentImage} />
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={t("composer.removeImage")}
                  hitSlop={6}
                  onPress={() => onImagesChange(images.filter((item) => item.id !== image.id))}
                  style={[styles.removeAttachment, { backgroundColor: palette.text }]}
                >
                  <HugeiconsIcon icon={Cancel01Icon} size={12} color={palette.card} strokeWidth={2.4} />
                </Pressable>
              </View>
            ))}
          </ScrollView>
        ) : null}
        <View style={styles.toolbar}>
          <IconButton icon={ImageAdd01Icon} label={t("composer.chooseImage")} palette={palette} tone="field" size={30} onPress={() => void pickImages()} disabled={disabled || imageBusy || images.length >= MAX_COMPOSER_IMAGES} />
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            keyboardShouldPersistTaps="handled"
            style={styles.chips}
            contentContainerStyle={styles.chipsContent}
          >
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
          {busy || imageBusy ? <ActivityIndicator size="small" color={palette.muted} style={styles.busy} /> : null}
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
    </View>
  );
});

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

function imageError(error: unknown): Error {
  const code = error instanceof Error ? error.message : "";
  return new Error(code === "image-too-large" ? t("composer.imageTooLarge") : t("composer.imageFailed"));
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
  attachments: { gap: 8, paddingHorizontal: 12, paddingBottom: 8 },
  attachment: { width: 64, height: 64, borderRadius: 10, borderWidth: StyleSheet.hairlineWidth, overflow: "visible" },
  attachmentImage: { width: "100%", height: "100%", borderRadius: 9 },
  removeAttachment: { position: "absolute", right: -6, top: -6, width: 20, height: 20, borderRadius: 10, alignItems: "center", justifyContent: "center" },
  toolbar: { flexDirection: "row", alignItems: "center", gap: 6, paddingLeft: 8, paddingRight: 8 },
  chips: { flex: 1 },
  chipsContent: { gap: 6, alignItems: "center", paddingRight: 4 },
  chip: { flexDirection: "row", alignItems: "center", gap: 5, maxWidth: 190, height: 30, borderRadius: radius.pill, paddingHorizontal: 10 },
  chipLabel: { fontSize: 13, fontWeight: "600", flexShrink: 1 },
  busy: { marginHorizontal: 2 },
  ring: { width: 28, height: 28, alignItems: "center", justifyContent: "center" },
  action: { width: 36, height: 36, borderRadius: 18, alignItems: "center", justifyContent: "center" },
});
