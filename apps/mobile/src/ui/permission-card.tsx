import { useState, type JSX } from "react";
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react-native";
import type { PermissionPrompt } from "../session/connection";
import { MessageQuestionIcon, ListChecksIcon, ShieldAlertIcon, Tick02Icon } from "./icons";
import { Gradient } from "./gradient";
import { haptic } from "./haptics";
import { elevation, radius, usePalette, type Palette } from "./theme";
import { t, useT } from "../i18n";

/**
 * The agent parked on a question — drawn where the composer was, as on the desktop.
 *
 * `onAlways` is offered only for a plain approval: it is the one kind of prompt that
 * recurs identically, which is what a remembered rule matches on.
 */
export function PermissionCard({
  prompt,
  busy,
  onRespond,
  onAlways,
}: {
  prompt: PermissionPrompt;
  busy: boolean;
  onRespond: (payload: Record<string, unknown>) => void;
  onAlways?: () => void;
}): JSX.Element {
  const palette = usePalette();
  useT();
  const [text, setText] = useState("");
  const [answers, setAnswers] = useState<string[]>(() => (prompt.questions ?? []).map(() => ""));
  const kind: { icon: IconSvgElement; eyebrow: string; tone: string; soft: string } =
    prompt.method === "confirm"
      ? { icon: ShieldAlertIcon, eyebrow: t("prompt.approve"), tone: palette.warning, soft: palette.warningSoft }
      : prompt.method === "plan_review"
        ? { icon: ListChecksIcon, eyebrow: t("prompt.plan"), tone: palette.accent, soft: palette.accentSoft }
        : { icon: MessageQuestionIcon, eyebrow: t("prompt.answer"), tone: palette.accent, soft: palette.accentSoft };
  const respond = (payload: Record<string, unknown>): void => {
    haptic.tap();
    onRespond(payload);
  };

  return (
    <View style={[styles.card, elevation(palette, 0), { backgroundColor: palette.card, borderColor: palette.border }]}>
      <View style={styles.head}>
        <View style={[styles.headIcon, { backgroundColor: kind.soft }]}>
          <HugeiconsIcon icon={kind.icon} size={18} color={kind.tone} strokeWidth={2} />
        </View>
        <View style={styles.headText}>
          <Text style={[styles.eyebrow, { color: kind.tone }]}>{kind.eyebrow}</Text>
          <Text style={[styles.title, { color: palette.text }]} numberOfLines={3}>{prompt.title || t("prompt.fallbackTitle")}</Text>
        </View>
      </View>

      <ScrollView style={styles.scroll} contentContainerStyle={styles.stack} keyboardShouldPersistTaps="handled" nestedScrollEnabled>
        {prompt.message ? (
          <View style={[styles.message, { backgroundColor: palette.field }]}>
            <Text selectable style={[styles.messageText, { color: palette.text }, prompt.method === "confirm" ? styles.mono : null]}>
              {prompt.message}
            </Text>
          </View>
        ) : null}
        {prompt.plan ? (
          <View style={[styles.message, { backgroundColor: palette.field }]}>
            <Text style={[styles.planTitle, { color: palette.text }]}>{prompt.plan.title}</Text>
            <Text selectable style={[styles.messageText, { color: palette.muted }]}>{prompt.plan.summary}</Text>
          </View>
        ) : null}

        {prompt.method === "select" && prompt.options ? (
          <View style={[styles.list, { backgroundColor: palette.background }]}>
            {prompt.options.map((option, index) => (
              <Pressable
                key={option}
                disabled={busy}
                onPress={() => respond({ id: prompt.id, value: option })}
                style={({ pressed }) => [
                  styles.option,
                  index > 0 ? { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: palette.border } : null,
                  pressed ? { backgroundColor: palette.field } : null,
                  { opacity: busy ? 0.5 : 1 },
                ]}
              >
                <View style={[styles.number, { backgroundColor: palette.accentSoft }]}>
                  <Text style={[styles.numberText, { color: palette.accent }]}>{index + 1}</Text>
                </View>
                <Text style={[styles.optionText, { color: palette.text }]}>{option}</Text>
              </Pressable>
            ))}
          </View>
        ) : null}

        {prompt.method === "input" || prompt.method === "editor" ? (
          <Field
            value={text}
            onChange={setText}
            placeholder={prompt.placeholder || t("prompt.inputPlaceholder")}
            palette={palette}
            multiline={prompt.method === "editor"}
          />
        ) : null}

        {prompt.method === "questions" && prompt.questions
          ? prompt.questions.map((question, index) => (
              <View key={`${question.question}-${index}`} style={styles.question}>
                {question.header ? <Text style={[styles.questionHeader, { color: palette.accent }]}>{question.header}</Text> : null}
                <Text style={[styles.questionText, { color: palette.text }]}>{question.question}</Text>
                {question.options ? (
                  <View style={styles.choices}>
                    {question.options.map((option) => {
                      const chosen = answers[index] === option;
                      return (
                        <Pressable
                          key={option}
                          disabled={busy}
                          onPress={() => {
                            haptic.select();
                            const next = answers.slice();
                            next[index] = option;
                            setAnswers(next);
                          }}
                          style={({ pressed }) => [
                            styles.choice,
                            {
                              backgroundColor: chosen ? palette.accentSoft : palette.background,
                              borderColor: chosen ? palette.accent : palette.border,
                              opacity: pressed ? 0.7 : 1,
                            },
                          ]}
                        >
                          {chosen ? <HugeiconsIcon icon={Tick02Icon} size={14} color={palette.accent} strokeWidth={2.6} /> : null}
                          <Text style={[styles.choiceText, { color: chosen ? palette.accent : palette.text }]}>{option}</Text>
                        </Pressable>
                      );
                    })}
                  </View>
                ) : (
                  <Field
                    value={answers[index] ?? ""}
                    onChange={(value) => {
                      const next = answers.slice();
                      next[index] = value;
                      setAnswers(next);
                    }}
                    placeholder={t("prompt.answerPlaceholder")}
                    palette={palette}
                  />
                )}
              </View>
            ))
          : null}

        {prompt.method === "plan_review" ? (
          <Field value={text} onChange={setText} placeholder={t("prompt.revisePlaceholder")} palette={palette} multiline />
        ) : null}
      </ScrollView>

      {prompt.method === "confirm" ? (
        <View style={styles.stackTight}>
          <View style={styles.row}>
            <Action fill label={t("prompt.deny")} palette={palette} disabled={busy} onPress={() => respond({ id: prompt.id, confirmed: false })} />
            <Action fill label={t("prompt.allow")} primary palette={palette} disabled={busy} onPress={() => respond({ id: prompt.id, confirmed: true })} />
          </View>
          {onAlways ? (
            <Pressable disabled={busy} onPress={onAlways} hitSlop={6} style={styles.always}>
              <Text style={[styles.alwaysText, { color: palette.muted }]}>{t("prompt.always")}</Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}
      {prompt.method === "input" || prompt.method === "editor" ? (
        <Action label={t("prompt.submit")} primary palette={palette} disabled={busy || text.trim().length === 0} onPress={() => respond({ id: prompt.id, value: text })} />
      ) : null}
      {prompt.method === "questions" && prompt.questions ? (
        <Action
          label={t("prompt.submitCount", { done: answers.filter((item) => item.trim()).length, total: answers.length })}
          primary
          palette={palette}
          disabled={busy || answers.some((item) => item.trim().length === 0)}
          onPress={() => respond({ id: prompt.id, answers })}
        />
      ) : null}
      {prompt.method === "plan_review" ? (
        <View style={styles.stackTight}>
          <Action label={t("prompt.run")} primary palette={palette} disabled={busy} onPress={() => respond({ id: prompt.id, planAction: "approve" })} />
          <View style={styles.row}>
            <Action fill label={t("prompt.skip")} palette={palette} disabled={busy} onPress={() => respond({ id: prompt.id, planAction: "ignore" })} />
            <Action
              fill
              label={t("prompt.revise")}
              palette={palette}
              disabled={busy || text.trim().length === 0}
              onPress={() => respond({ id: prompt.id, planAction: "revise", value: text })}
            />
          </View>
        </View>
      ) : null}
    </View>
  );
}

function Field({
  value,
  onChange,
  placeholder,
  palette,
  multiline,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  palette: Palette;
  multiline?: boolean;
}): JSX.Element {
  return (
    <TextInput
      value={value}
      onChangeText={onChange}
      placeholder={placeholder}
      placeholderTextColor={palette.subtle}
      multiline={multiline}
      style={[styles.input, { color: palette.text, backgroundColor: palette.field }, multiline ? styles.inputMulti : null]}
    />
  );
}

function Action({
  label,
  onPress,
  disabled,
  primary,
  palette,
  fill,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  primary?: boolean;
  palette: Palette;
  /** Share a row's width with its siblings. */
  fill?: boolean;
}): JSX.Element {
  return (
    <Pressable
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [fill ? styles.fill : null, { opacity: disabled ? 0.45 : pressed ? 0.8 : 1 }]}
    >
      {primary ? (
        <Gradient colors={palette.brand} radius={radius.md} style={styles.button}>
          <Text style={[styles.buttonText, { color: "#ffffff" }]}>{label}</Text>
        </Gradient>
      ) : (
        <View style={[styles.button, { backgroundColor: palette.field, borderRadius: radius.md }]}>
          <Text style={[styles.buttonText, { color: palette.text }]}>{label}</Text>
        </View>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: { borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.xl, padding: 14, gap: 12 },
  head: { flexDirection: "row", alignItems: "center", gap: 12 },
  headIcon: { width: 36, height: 36, borderRadius: 11, alignItems: "center", justifyContent: "center" },
  headText: { flex: 1, minWidth: 0, gap: 1 },
  eyebrow: { fontSize: 12, fontWeight: "700", letterSpacing: 0.3 },
  title: { fontSize: 16, fontWeight: "700", lineHeight: 21 },
  scroll: { maxHeight: 320, flexGrow: 0 },
  stack: { gap: 10 },
  stackTight: { gap: 8 },
  message: { borderRadius: radius.md, paddingHorizontal: 12, paddingVertical: 10, gap: 4 },
  messageText: { fontSize: 14, lineHeight: 20 },
  mono: { fontFamily: "monospace", fontSize: 13 },
  planTitle: { fontSize: 15, fontWeight: "700" },
  list: { borderRadius: radius.md, overflow: "hidden" },
  option: { flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 12, paddingVertical: 12 },
  number: { width: 24, height: 24, borderRadius: 7, alignItems: "center", justifyContent: "center" },
  numberText: { fontSize: 12, fontWeight: "800" },
  optionText: { flex: 1, fontSize: 15 },
  question: { gap: 8 },
  questionHeader: { fontSize: 12, fontWeight: "700" },
  questionText: { fontSize: 15, lineHeight: 21, fontWeight: "500" },
  choices: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  choice: { flexDirection: "row", alignItems: "center", gap: 5, borderWidth: 1, borderRadius: radius.pill, paddingHorizontal: 12, paddingVertical: 8 },
  choiceText: { fontSize: 14, fontWeight: "500" },
  input: { borderRadius: radius.md, paddingHorizontal: 12, paddingVertical: 11, fontSize: 16 },
  inputMulti: { minHeight: 84, textAlignVertical: "top" },
  row: { flexDirection: "row", gap: 8 },
  fill: { flex: 1 },
  button: { height: 46, alignItems: "center", justifyContent: "center", paddingHorizontal: 12 },
  buttonText: { fontSize: 15, fontWeight: "700" },
  always: { alignSelf: "center", paddingVertical: 4 },
  alwaysText: { fontSize: 13, fontWeight: "600" },
});
