import { Stack, useFocusEffect, useRouter } from "expo-router";
import { useCallback, useState, type JSX, type ReactNode } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { addressKindLabel, parseServerAddress } from "../protocol/address";
import { connectSaved, currentConnection } from "../session/connection";
import { upsertServer, writeToken } from "../storage/servers";
import { RemoteClient } from "../protocol/client";
import { takeScannedAddress } from "../ui/scanned";
import { usePalette } from "../ui/theme";

export default function AddServerScreen() {
  const palette = usePalette();
  const router = useRouter();
  const [url, setUrl] = useState("");
  const [alias, setAlias] = useState("");
  const [aliasTouched, setAliasTouched] = useState(false);
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useFocusEffect(
    useCallback(() => {
      const scanned = takeScannedAddress();
      if (!scanned) return;
      setUrl(scanned);
      setError(null);
    }, []),
  );

  const parsed = parseServerAddress(url);
  const shownAlias = aliasTouched ? alias : alias || parsed?.host || "";

  async function submit(): Promise<void> {
    const address = parseServerAddress(url);
    if (!address) {
      setError("地址无法识别。可以是 192.168.x.x:7777，或 https 穿透链接。");
      return;
    }
    if (!password) {
      setError("请输入远程访问密码");
      return;
    }
    setBusy(true);
    setError(null);
    const name = (aliasTouched ? alias : shownAlias).trim() || address.host;
    try {
      const remote = new RemoteClient();
      const token = await remote.login(address.origin, password, `FastVibe ${name}`);
      const saved = await upsertServer({
        id: newId(),
        alias: name,
        origin: address.origin,
        host: address.host,
        kind: address.kind,
        createdAt: Date.now(),
      });
      await writeToken(saved.id, token);
      await connectSaved(saved);
      if (currentConnection().status !== "ready") {
        setError(currentConnection().error ?? "已保存，但这次没有连上");
        return;
      }
      router.replace(`/server/${saved.id}`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "登录失败");
    } finally {
      setBusy(false);
    }
  }

  return (
    <ScrollView style={{ flex: 1, backgroundColor: palette.background }} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      <Stack.Screen options={{ title: "添加设备" }} />
      <Text style={[styles.hint, { color: palette.muted }]}>
        同一 Wi-Fi 时，把设置里复制的 192.168.x.x:7777 粘贴进来即可，不必加 http://。电脑需要打开「允许局域网访问」。外网则扫穿透二维码，或粘贴 https 链接。
      </Text>
      <Field label="地址" palette={palette}>
        <TextInput
          value={url}
          onChangeText={setUrl}
          autoCapitalize="none"
          autoCorrect={false}
          placeholder="192.168.1.2:7777"
          placeholderTextColor={palette.muted}
          style={[styles.input, { color: palette.text, borderColor: palette.border }]}
        />
      </Field>
      <Pressable onPress={() => router.push("/scan")} style={[styles.scan, { borderColor: palette.border }]}>
        <Text style={{ color: palette.accent, fontSize: 16 }}>扫描二维码</Text>
      </Pressable>
      {parsed ? (
        <Text style={[styles.parsed, { color: parsed.kind === "loopback" ? palette.danger : palette.muted }]}>
          将连接 {parsed.origin} · {addressKindLabel(parsed.kind)}
          {parsed.kind === "loopback" ? "。这是本机地址，手机连不上，请改用电脑上显示的局域网地址。" : ""}
        </Text>
      ) : url.trim() ? (
        <Text style={[styles.parsed, { color: palette.danger }]}>无法识别这个地址</Text>
      ) : null}
      <Field label="别名" palette={palette}>
        <TextInput
          value={shownAlias}
          onChangeText={(value) => {
            setAliasTouched(true);
            setAlias(value);
          }}
          placeholder="例如 家里的 Mac"
          placeholderTextColor={palette.muted}
          style={[styles.input, { color: palette.text, borderColor: palette.border }]}
        />
      </Field>
      <Field label="密码" palette={palette}>
        <TextInput
          value={password}
          onChangeText={setPassword}
          secureTextEntry
          placeholder="远程访问密码"
          placeholderTextColor={palette.muted}
          style={[styles.input, { color: palette.text, borderColor: palette.border }]}
        />
      </Field>
      {error ? <Text style={[styles.parsed, { color: palette.danger }]}>{error}</Text> : null}
      <Pressable
        disabled={busy}
        onPress={() => void submit()}
        style={[styles.submit, { backgroundColor: palette.accent, opacity: busy ? 0.6 : 1 }]}
      >
        {busy ? <ActivityIndicator color={palette.accentText} /> : <Text style={[styles.submitLabel, { color: palette.accentText }]}>登录并保存</Text>}
      </Pressable>
    </ScrollView>
  );
}

function newId(): string {
  return `srv-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function Field({
  label,
  palette,
  children,
}: {
  label: string;
  palette: { text: string };
  children: ReactNode;
}): JSX.Element {
  return (
    <View style={styles.field}>
      <Text style={[styles.label, { color: palette.text }]}>{label}</Text>
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  content: { padding: 16, gap: 14 },
  hint: { fontSize: 14, lineHeight: 21 },
  field: { gap: 6 },
  label: { fontSize: 14, fontWeight: "600" },
  input: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 12, paddingHorizontal: 12, paddingVertical: 12, fontSize: 16 },
  scan: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 12, paddingVertical: 12, alignItems: "center" },
  parsed: { fontSize: 13, lineHeight: 19 },
  submit: { borderRadius: 12, minHeight: 48, alignItems: "center", justifyContent: "center" },
  submitLabel: { fontSize: 16, fontWeight: "600" },
});
