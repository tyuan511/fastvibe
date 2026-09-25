import { useCallback, useEffect, useState, type JSX } from "react";
import { ActivityIndicator, Alert, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { HugeiconsIcon } from "@hugeicons/react-native";
import { ArrowDown01Icon, ArrowUp02Icon, HandIcon, PlayIcon, ShieldAlertIcon, ShieldCheckIcon, SquareIcon } from "../ui/icons";
import type { IconSvgElement } from "@hugeicons/react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { getClient } from "../session/connection";
import { OptionSheet, type OptionGroup } from "./option-sheet";
import { usePalette } from "../ui/theme";

type EngineModel = { provider: string; id: string };
type FastVibeModel = { provider: string; providerName: string; id: string; name: string; thinkingLevels?: string[] };
type SessionState = { model?: EngineModel; thinkingLevel?: string };
type Picker = "model" | "thinking" | "permission" | null;

const THINKING_LABEL: Record<string, string> = {
  off: "关闭推理", minimal: "极低", low: "低", medium: "中", high: "高", xhigh: "极高", max: "最高", auto: "跟随模型默认",
};
const PERMISSION_LABEL: Record<string, string> = { ask: "请求批准", smart: "帮我批准", full: "完全访问" };
const PERMISSION_DESCRIPTION: Record<string, string> = {
  ask: "敏感操作都要你确认", smart: "低风险自动批准，高风险问你", full: "什么都不问（谨慎）",
};
const PERMISSION_MODES = ["ask", "smart", "full"] as const;

/** Mobile equivalent of the desktop composer card. */
export function Composer({
  conversationId,
  running,
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
  disabled: boolean;
  draft: string;
  onDraftChange: (text: string) => void;
  onSend: () => void;
  onAbort: () => void;
  onContinue: () => void;
  canContinue: boolean;
}): JSX.Element {
  const palette = usePalette();
  const insets = useSafeAreaInsets();
  const [picker, setPicker] = useState<Picker>(null);
  const [models, setModels] = useState<FastVibeModel[]>([]);
  const [session, setSession] = useState<SessionState | null>(null);
  const [permissionMode, setPermissionMode] = useState("smart");
  const [fullAccessConfirmed, setFullAccessConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    const remote = getClient();
    if (!remote) return;
    try {
      const [state, list, settings] = await Promise.all([
        remote.call("engine:get-state", { conversationId }) as Promise<SessionState>,
        remote.call("engine:get-models", { conversationId }) as Promise<FastVibeModel[]>,
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

  useEffect(() => { void refresh(); }, [refresh]);

  const currentModel = session?.model;
  const catalog = currentModel ? models.find((item) => item.provider === currentModel.provider && item.id === currentModel.id) : undefined;
  const levels = (catalog?.thinkingLevels ?? []).filter((level) => level !== "off");
  const modelGroups: OptionGroup[] = (() => {
    const groups = new Map<string, OptionGroup>();
    for (const model of models) {
      const group = groups.get(model.provider) ?? { label: model.providerName, options: [] };
      group.options.push({ value: modelKey(model), label: model.name || model.id });
      groups.set(model.provider, group);
    }
    return [...groups.values()];
  })();

  async function chooseModel(value: string): Promise<void> {
    const remote = getClient();
    const [provider, modelId] = value.split("\u0000");
    if (!remote || !provider || !modelId || busy) return;
    setBusy(true);
    try {
      let next = (await remote.call("engine:set-model", { provider, modelId, conversationId })) as SessionState;
      const offered = models.find((item) => item.provider === provider && item.id === modelId)?.thinkingLevels?.filter((level) => level !== "off");
      if (offered?.length && (!next.thinkingLevel || !offered.includes(next.thinkingLevel))) {
        next = (await remote.call("engine:set-thinking", { level: offered.includes("high") ? "high" : offered[0], conversationId })) as SessionState;
      }
      setSession(next);
    } catch (error) {
      Alert.alert("模型未切换", error instanceof Error ? error.message : "切换失败");
    } finally {
      setBusy(false);
    }
  }

  async function chooseThinking(level: string): Promise<void> {
    const remote = getClient();
    if (!remote || busy) return;
    setBusy(true);
    try {
      setSession((await remote.call("engine:set-thinking", { level, conversationId })) as SessionState);
    } catch (error) {
      Alert.alert("推理强度未更改", error instanceof Error ? error.message : "保存失败");
    } finally {
      setBusy(false);
    }
  }

  async function choosePermission(mode: string): Promise<void> {
    if (mode === "full" && !fullAccessConfirmed) {
      Alert.alert("开启完全访问？", "完全访问会允许代理直接执行操作，不再逐项询问。只在你信任当前会话时开启。", [
        { text: "取消", style: "cancel" },
        { text: "开启", style: "destructive", onPress: () => void savePermission(mode, true) },
      ]);
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
      Alert.alert("权限模式未更改", error instanceof Error ? error.message : "保存失败");
    } finally {
      setBusy(false);
    }
  }

  const hasContent = draft.trim().length > 0;
  const action = running && !hasContent ? "stop" : canContinue && !hasContent ? "continue" : "send";

  return (
    <View style={[styles.outer, { paddingBottom: insets.bottom + 8 }]}>
      <View style={[styles.card, { backgroundColor: palette.card, borderColor: palette.border }]}>
        <TextInput
          value={draft}
          onChangeText={onDraftChange}
          placeholder={disabled ? "还没有连上这台设备" : running && !hasContent ? "正在工作，输入后将加入队列" : "发消息"}
          placeholderTextColor={palette.muted}
          multiline
          editable={!disabled}
          style={[styles.input, { color: palette.text }]}
        />
        <View style={styles.toolbar}>
          <Chip
            label={PERMISSION_LABEL[permissionMode] ?? permissionMode}
            icon={permissionMode === "ask" ? HandIcon : permissionMode === "full" ? ShieldCheckIcon : ShieldAlertIcon}
            destructive={permissionMode === "full"}
            disabled={disabled || busy}
            onPress={() => setPicker("permission")}
          />
          {busy ? <ActivityIndicator size="small" color={palette.muted} /> : null}
          <View style={styles.spacer} />
          <Chip
            label={catalog?.name || currentModel?.id || "默认模型"}
            disabled={disabled || busy || models.length === 0}
            onPress={() => setPicker("model")}
          />
          {levels.length > 0 ? (
            <Chip label={session?.thinkingLevel ? THINKING_LABEL[session.thinkingLevel] ?? session.thinkingLevel : "思考"} disabled={disabled || busy} onPress={() => setPicker("thinking")} />
          ) : null}
          <Pressable
            onPress={action === "stop" ? onAbort : action === "continue" ? onContinue : onSend}
            disabled={disabled || (action === "send" && !hasContent)}
            style={[styles.action, { backgroundColor: action === "stop" ? palette.danger : palette.accent, opacity: disabled || (action === "send" && !hasContent) ? 0.4 : 1 }]}
          >
            <HugeiconsIcon icon={action === "stop" ? SquareIcon : action === "continue" ? PlayIcon : ArrowUp02Icon} size={16} color={palette.accentText} strokeWidth={2} />
          </Pressable>
        </View>
      </View>

      <OptionSheet open={picker === "model"} title="模型" groups={modelGroups} value={currentModel ? modelKey(currentModel) : null} onSelect={(value) => void chooseModel(value)} onClose={() => setPicker(null)} />
      <OptionSheet open={picker === "thinking"} title="推理强度" groups={[{ label: "", options: levels.map((level) => ({ value: level, label: THINKING_LABEL[level] ?? level })) }]} value={session?.thinkingLevel ?? null} onSelect={(value) => void chooseThinking(value)} onClose={() => setPicker(null)} />
      <OptionSheet open={picker === "permission"} title="权限模式" groups={[{ label: "", options: PERMISSION_MODES.map((mode) => ({ value: mode, label: PERMISSION_LABEL[mode], description: PERMISSION_DESCRIPTION[mode] })) }]} value={permissionMode} onSelect={(value) => void choosePermission(value)} onClose={() => setPicker(null)} />
    </View>
  );
}

function modelKey(model: { provider: string; id: string }): string {
  return `${model.provider}\u0000${model.id}`;
}

function Chip({ label, icon, destructive, disabled, onPress }: { label: string; icon?: IconSvgElement; destructive?: boolean; disabled?: boolean; onPress: () => void }): JSX.Element {
  const palette = usePalette();
  return (
    <Pressable onPress={onPress} disabled={disabled} style={[styles.chip, { opacity: disabled ? 0.45 : 1 }]}>
      {icon ? <HugeiconsIcon icon={icon} size={14} color={destructive ? palette.danger : palette.muted} strokeWidth={2} /> : null}
      <Text style={{ color: destructive ? palette.danger : palette.muted, fontSize: 13 }} numberOfLines={1}>{label}</Text>
      <HugeiconsIcon icon={ArrowDown01Icon} size={12} color={palette.muted} strokeWidth={2} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  outer: { paddingHorizontal: 10, paddingTop: 6 },
  card: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 22, shadowColor: "#000", shadowOpacity: 0.08, shadowRadius: 4, shadowOffset: { width: 0, height: 1 }, elevation: 1 },
  input: { minHeight: 48, maxHeight: 132, paddingHorizontal: 16, paddingTop: 13, paddingBottom: 8, fontSize: 15, lineHeight: 22 },
  toolbar: { minHeight: 42, flexDirection: "row", alignItems: "center", gap: 2, paddingHorizontal: 8, paddingBottom: 7 },
  chip: { flexDirection: "row", alignItems: "center", gap: 3, maxWidth: 132, borderRadius: 16, paddingHorizontal: 6, paddingVertical: 6 },
  spacer: { flex: 1 },
  action: { width: 30, height: 30, borderRadius: 15, alignItems: "center", justifyContent: "center", marginLeft: 3 },
});
