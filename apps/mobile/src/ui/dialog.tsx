import { useEffect, useState, useSyncExternalStore, type JSX } from "react";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  useWindowDimensions,
} from "react-native";
import { t } from "../i18n";
import { haptic } from "./haptics";
import { useOpenSheets } from "./overlay";
import { elevation, radius, usePalette, type Palette } from "./theme";
import { ToastHost } from "./toast";

/**
 * Every dialog the app shows — a confirmation, a notice, a text prompt — in one look.
 *
 * The system `Alert` used to cover some of these and a hand-drawn modal the rest, so
 * deleting a chat and renaming it looked like two different apps. `DialogHost`
 * (mounted once, in the root layout) draws them one at a time, in the order they
 * were asked for, and never while a sheet is on screen (`overlay.ts`).
 */
export type DialogAction = {
  label: string;
  style?: "default" | "cancel" | "destructive";
  onPress?: () => void;
};

type PromptOptions = {
  initial?: string;
  placeholder?: string;
  secure?: boolean;
  submitLabel?: string;
  /** Resolve `false` to keep the dialog open (the write failed and said why). */
  onSubmit: (value: string) => void | boolean | Promise<void | boolean>;
};

type Request = {
  id: number;
  title: string;
  message?: string;
  actions: DialogAction[];
  prompt?: PromptOptions;
};

let queue: Request[] = [];
let nextId = 1;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

function push(request: Omit<Request, "id">): void {
  queue = [...queue, { ...request, id: nextId++ }];
  emit();
}

function shift(id: number): void {
  queue = queue.filter((item) => item.id !== id);
  emit();
}

export const dialog = {
  /** A notice with one button, or the given actions. */
  alert(title: string, message?: string, actions?: DialogAction[]): void {
    push({ title, message, actions: actions ?? [{ label: t("common.ok") }] });
  },
  confirm(options: { title: string; message?: string; confirmLabel: string; destructive?: boolean; onConfirm: () => void }): void {
    push({
      title: options.title,
      message: options.message,
      actions: [
        { label: t("common.cancel"), style: "cancel" },
        { label: options.confirmLabel, style: options.destructive ? "destructive" : "default", onPress: options.onConfirm },
      ],
    });
  },
  prompt(options: { title: string; message?: string } & PromptOptions): void {
    const { title, message, ...prompt } = options;
    push({ title, message, actions: [], prompt });
  },
};

export function DialogHost(): JSX.Element | null {
  const palette = usePalette();
  const { height } = useWindowDimensions();
  const current = useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => queue[0] ?? null,
    () => queue[0] ?? null,
  );
  const sheets = useOpenSheets();
  const [armed, setArmed] = useState(false);
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);

  // Present only once no sheet is on screen, and a beat after the last one went, so
  // its native dismissal has finished.
  useEffect(() => {
    if (!current || sheets > 0) {
      setArmed(false);
      return undefined;
    }
    const timer = setTimeout(() => setArmed(true), 60);
    return () => clearTimeout(timer);
  }, [current, sheets]);

  useEffect(() => {
    setValue(current?.prompt?.initial ?? "");
    setBusy(false);
  }, [current]);

  if (!current) return null;

  function choose(action: DialogAction): void {
    if (!current) return;
    haptic.tap();
    shift(current.id);
    action.onPress?.();
  }

  async function submit(): Promise<void> {
    const prompt = current?.prompt;
    if (!current || !prompt || busy || !value.trim()) return;
    setBusy(true);
    try {
      const result = await prompt.onSubmit(value);
      if (result !== false) shift(current.id);
    } finally {
      setBusy(false);
    }
  }

  const cancel = (): void => {
    if (busy) return;
    const cancelAction = current.actions.find((action) => action.style === "cancel");
    if (current.prompt || cancelAction || current.actions.length <= 1) {
      shift(current.id);
      cancelAction?.onPress?.();
    }
  };

  const actions: DialogAction[] = current.prompt
    ? [
        { label: t("common.cancel"), style: "cancel" },
        { label: current.prompt.submitLabel ?? t("common.save"), style: "default" },
      ]
    : current.actions;
  const stacked = actions.length > 2;

  return (
    <Modal transparent visible={armed} animationType="fade" onRequestClose={cancel} statusBarTranslucent>
      <KeyboardAvoidingView style={styles.fill} behavior={Platform.OS === "ios" ? "padding" : undefined}>
        <Pressable style={[styles.backdrop, { backgroundColor: palette.overlay }]} onPress={cancel}>
          <Pressable style={[styles.card, elevation(palette, 2), { backgroundColor: palette.card }]} onPress={() => undefined}>
            <Text style={[styles.title, { color: palette.text }]}>{current.title}</Text>
            {current.message ? (
              <ScrollView style={{ maxHeight: height * 0.4 }} contentContainerStyle={styles.messageBox}>
                <Text style={[styles.message, { color: palette.muted }]}>{current.message}</Text>
              </ScrollView>
            ) : null}
            {current.prompt ? (
              <TextInput
                value={value}
                onChangeText={setValue}
                autoFocus
                selectTextOnFocus
                secureTextEntry={current.prompt.secure}
                placeholder={current.prompt.placeholder}
                placeholderTextColor={palette.subtle}
                returnKeyType="done"
                onSubmitEditing={() => void submit()}
                style={[styles.input, { color: palette.text, backgroundColor: palette.field }]}
              />
            ) : null}
            <View style={stacked ? styles.stack : styles.row}>
              {actions.map((action, index) => (
                <DialogButton
                  key={`${action.label}-${index}`}
                  action={action}
                  palette={palette}
                  fill={!stacked}
                  busy={busy && Boolean(current.prompt) && action.style !== "cancel"}
                  disabled={Boolean(current.prompt) && action.style !== "cancel" && (!value.trim() || busy)}
                  onPress={() => {
                    if (current.prompt) {
                      if (action.style === "cancel") cancel();
                      else void submit();
                    } else {
                      choose(action);
                    }
                  }}
                />
              ))}
            </View>
          </Pressable>
        </Pressable>
      </KeyboardAvoidingView>
      <ToastHost />
    </Modal>
  );
}

function DialogButton({
  action,
  palette,
  fill,
  busy,
  disabled,
  onPress,
}: {
  action: DialogAction;
  palette: Palette;
  fill: boolean;
  busy: boolean;
  disabled: boolean;
  onPress: () => void;
}): JSX.Element {
  const style = action.style ?? "default";
  const background = style === "cancel" ? palette.field : style === "destructive" ? palette.danger : palette.accent;
  const color = style === "cancel" ? palette.text : "#ffffff";
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      style={({ pressed }) => [
        styles.button,
        fill ? styles.fill : null,
        { backgroundColor: background, opacity: disabled && !busy ? 0.4 : pressed ? 0.8 : 1 },
      ]}
    >
      {busy ? <ActivityIndicator color={color} /> : <Text style={[styles.buttonLabel, { color }]}>{action.label}</Text>}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  backdrop: { flex: 1, justifyContent: "center", padding: 28 },
  card: { borderRadius: radius.xl, padding: 20, gap: 12, width: "100%", maxWidth: 420, alignSelf: "center" },
  title: { fontSize: 18, fontWeight: "700", lineHeight: 24 },
  messageBox: { paddingBottom: 2 },
  message: { fontSize: 15, lineHeight: 22 },
  input: { borderRadius: radius.md, paddingHorizontal: 14, paddingVertical: 12, fontSize: 16 },
  row: { flexDirection: "row", gap: 10, marginTop: 6 },
  stack: { gap: 8, marginTop: 6 },
  button: { height: 46, borderRadius: radius.md, alignItems: "center", justifyContent: "center", paddingHorizontal: 12 },
  buttonLabel: { fontSize: 16, fontWeight: "700" },
});
