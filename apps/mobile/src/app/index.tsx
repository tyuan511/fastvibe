import { Stack, useFocusEffect, useRouter } from "expo-router";
import { useCallback, useState } from "react";
import { Alert, FlatList, Pressable, StyleSheet, Text, View } from "react-native";
import { addressKindLabel } from "../protocol/address";
import { loadServers, patchServer, removeServer, type SavedServer } from "../storage/servers";
import { TextPrompt } from "../ui/text-prompt";
import { usePalette } from "../ui/theme";
import { BrandLogo } from "../ui/brand";
import { UpdateBanner } from "../update/update-banner";

export default function DevicesScreen() {
  const palette = usePalette();
  const router = useRouter();
  const [servers, setServers] = useState<SavedServer[]>([]);
  const [editing, setEditing] = useState<SavedServer | null>(null);
  const [alias, setAlias] = useState("");

  const reload = useCallback(() => {
    void loadServers().then(setServers);
  }, []);
  useFocusEffect(reload);

  function remove(server: SavedServer): void {
    Alert.alert("删除设备", `不再保存「${server.alias}」。已登录的令牌也会删掉。`, [
      { text: "取消", style: "cancel" },
      {
        text: "删除",
        style: "destructive",
        onPress: () => {
          void removeServer(server.id).then(setServers);
        },
      },
    ]);
  }

  return (
    <View style={[styles.screen, { backgroundColor: palette.background }]}>
      <Stack.Screen
        options={{
          title: "设备",
          headerRight: () => (
            <Pressable onPress={() => router.push("/add")} hitSlop={8}>
              <Text style={{ color: palette.accent, fontSize: 17 }}>添加</Text>
            </Pressable>
          ),
        }}
      />
      <UpdateBanner palette={palette} />
      {servers.length === 0 ? (
        <View style={styles.empty}>
          <BrandLogo size={82} />
          <Text style={[styles.emptyTitle, { color: palette.text }]}>还没有保存的设备</Text>
          <Text style={[styles.emptyBody, { color: palette.muted }]}>
            扫穿透二维码，或粘贴局域网地址，之后从这里一点就能连上。
          </Text>
          <Pressable onPress={() => router.push("/add")} style={[styles.add, { backgroundColor: palette.accent }]}>
            <Text style={[styles.addLabel, { color: palette.accentText }]}>添加设备</Text>
          </Pressable>
        </View>
      ) : (
        <FlatList
          data={servers}
          keyExtractor={(item) => item.id}
          contentContainerStyle={styles.list}
          renderItem={({ item }) => (
            <Pressable
              onPress={() => router.push(`/server/${item.id}`)}
              onLongPress={() => remove(item)}
              style={[styles.row, { backgroundColor: palette.card }]}
            >
              <View style={styles.rowText}>
                <Text style={[styles.alias, { color: palette.text }]}>{item.alias}</Text>
                <Text style={[styles.host, { color: palette.muted }]} numberOfLines={1}>
                  {addressKindLabel(item.kind)} · {item.host}
                </Text>
              </View>
              <Pressable
                onPress={() => {
                  setEditing(item);
                  setAlias(item.alias);
                }}
                hitSlop={8}
              >
                <Text style={{ color: palette.accent, fontSize: 15 }}>别名</Text>
              </Pressable>
            </Pressable>
          )}
        />
      )}
      {editing ? (
        <TextPrompt
          title="设备别名"
          value={alias}
          onChange={setAlias}
          onCancel={() => setEditing(null)}
          onSubmit={() => {
            const next = alias.trim();
            if (!next) return;
            void patchServer(editing.id, { alias: next }).then(setServers);
            setEditing(null);
          }}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  list: { padding: 16, gap: 10 },
  row: { borderRadius: 14, paddingHorizontal: 16, paddingVertical: 14, flexDirection: "row", alignItems: "center", gap: 12 },
  rowText: { flex: 1, gap: 4 },
  alias: { fontSize: 17, fontWeight: "600" },
  host: { fontSize: 13 },
  empty: { flex: 1, alignItems: "center", justifyContent: "center", paddingHorizontal: 32, gap: 10 },
  emptyTitle: { fontSize: 17, fontWeight: "600" },
  emptyBody: { fontSize: 15, lineHeight: 22, textAlign: "center" },
  add: { marginTop: 8, borderRadius: 12, paddingHorizontal: 18, paddingVertical: 12 },
  addLabel: { fontSize: 16, fontWeight: "600" },
});
