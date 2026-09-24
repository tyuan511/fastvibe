import { useState, type JSX } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import type { PermissionPrompt } from "../session/connection";
import { usePalette } from "./theme";

export function PermissionCard({
  prompt,
  busy,
  onRespond,
}: {
  prompt: PermissionPrompt;
  busy: boolean;
  onRespond: (payload: Record<string, unknown>) => void;
}): JSX.Element {
  const palette = usePalette();
  const [text, setText] = useState("");
  const [answers, setAnswers] = useState<string[]>(() => (prompt.questions ?? []).map(() => ""));

  return (
    <View style={[styles.card, { backgroundColor: palette.card, borderColor: palette.border }]}>
      <Text style={[styles.title, { color: palette.text }]}>{prompt.title || "需要你处理"}</Text>
      {prompt.message ? <Text style={[styles.body, { color: palette.muted }]}>{prompt.message}</Text> : null}
      {prompt.plan ? (
        <Text style={[styles.body, { color: palette.text }]}>
          {prompt.plan.title}
          {"\n"}
          {prompt.plan.summary}
        </Text>
      ) : null}

      {prompt.method === "confirm" ? (
        <View style={styles.row}>
          <Action label="拒绝" disabled={busy} onPress={() => onRespond({ id: prompt.id, confirmed: false })} />
          <Action label="允许" primary disabled={busy} onPress={() => onRespond({ id: prompt.id, confirmed: true })} />
        </View>
      ) : null}

      {prompt.method === "select" && prompt.options ? (
        <View style={styles.options}>
          {prompt.options.map((option) => (
            <Action key={option} label={option} disabled={busy} onPress={() => onRespond({ id: prompt.id, value: option })} />
          ))}
        </View>
      ) : null}

      {prompt.method === "input" || prompt.method === "editor" ? (
        <View style={styles.stack}>
          <TextInput
            value={text}
            onChangeText={setText}
            placeholder={prompt.placeholder || "输入"}
            placeholderTextColor={palette.muted}
            style={[styles.input, { color: palette.text, borderColor: palette.border }]}
          />
          <Action label="提交" primary disabled={busy || text.trim().length === 0} onPress={() => onRespond({ id: prompt.id, value: text })} />
        </View>
      ) : null}

      {prompt.method === "questions" && prompt.questions ? (
        <View style={styles.stack}>
          {prompt.questions.map((question, index) => (
            <View key={`${question.question}-${index}`} style={styles.stack}>
              <Text style={[styles.body, { color: palette.text }]}>{question.header ? `${question.header} · ` : ""}{question.question}</Text>
              {question.options ? (
                <View style={styles.options}>
                  {question.options.map((option) => (
                    <Action
                      key={option}
                      label={option}
                      disabled={busy}
                      onPress={() => {
                        const next = answers.slice();
                        next[index] = option;
                        setAnswers(next);
                      }}
                    />
                  ))}
                </View>
              ) : (
                <TextInput
                  value={answers[index] ?? ""}
                  onChangeText={(value) => {
                    const next = answers.slice();
                    next[index] = value;
                    setAnswers(next);
                  }}
                  placeholder="回答"
                  placeholderTextColor={palette.muted}
                  style={[styles.input, { color: palette.text, borderColor: palette.border }]}
                />
              )}
            </View>
          ))}
          <Action
            label="提交"
            primary
            disabled={busy || answers.some((item) => item.trim().length === 0)}
            onPress={() => onRespond({ id: prompt.id, answers })}
          />
        </View>
      ) : null}

      {prompt.method === "plan_review" ? (
        <View style={styles.stack}>
          <TextInput
            value={text}
            onChangeText={setText}
            placeholder="要修改的话，写在这里"
            placeholderTextColor={palette.muted}
            style={[styles.input, { color: palette.text, borderColor: palette.border }]}
          />
          <View style={styles.row}>
            <Action label="先不执行" disabled={busy} onPress={() => onRespond({ id: prompt.id, planAction: "ignore" })} />
            <Action
              label="按意见修改"
              disabled={busy || text.trim().length === 0}
              onPress={() => onRespond({ id: prompt.id, planAction: "revise", value: text })}
            />
            <Action label="开始执行" primary disabled={busy} onPress={() => onRespond({ id: prompt.id, planAction: "approve" })} />
          </View>
        </View>
      ) : null}
    </View>
  );
}

function Action({
  label,
  onPress,
  disabled,
  primary,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  primary?: boolean;
}): JSX.Element {
  const palette = usePalette();
  return (
    <Pressable
      disabled={disabled}
      onPress={onPress}
      style={[styles.button, { backgroundColor: primary ? palette.accent : palette.background, opacity: disabled ? 0.45 : 1 }]}
    >
      <Text style={{ color: primary ? palette.accentText : palette.text, fontSize: 15 }}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 12, padding: 12, gap: 8 },
  title: { fontSize: 15, fontWeight: "600" },
  body: { fontSize: 14, lineHeight: 20 },
  row: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  options: { gap: 8 },
  stack: { gap: 8 },
  input: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, fontSize: 16 },
  button: { borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, alignItems: "center" },
});
