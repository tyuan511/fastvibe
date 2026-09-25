import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { useEffect, useMemo, useState, type JSX } from "react";
import { FlatList, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { HugeiconsIcon } from "@hugeicons/react-native";
import { Alert02Icon, ArrowDown01Icon, Cancel01Icon, Folder01Icon, Search01Icon } from "../../ui/icons";
import { connectSaved, currentConnection, loginSaved, useConnection, getClient, type CatalogConversation } from "../../session/connection";
import { loadServers, type SavedServer } from "../../storage/servers";
import { usePalette } from "../../ui/theme";
import { BrandLoading } from "../../ui/brand";
import { DesktopSpinner } from "../../chat/desktop-spinner";
import { OptionSheet } from "../../chat/option-sheet";

/** The sheet's value for 「no project filter」; a cwd can never be empty. */
const ALL_PROJECTS = "";

export default function ServerScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const palette = usePalette();
  const router = useRouter();
  const connection = useConnection();
  const [server, setServer] = useState<SavedServer | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [password, setPassword] = useState("");
  const [query, setQuery] = useState("");
  const [project, setProject] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [pickingProject, setPickingProject] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoaded(false);
    void loadServers().then((servers) => {
      if (cancelled) return;
      const found = servers.find((item) => item.id === id) ?? null;
      setServer(found);
      setLoaded(true);
      if (!found) return;
      const current = currentConnection();
      if (current.server?.id === found.id && (current.status === "ready" || current.status === "connecting")) return;
      void connectSaved(found);
    });
    return () => {
      cancelled = true;
    };
  }, [id]);

  const listed = useMemo(
    () =>
      connection.conversations
        .filter((item) => item.kind !== "side-chat")
        .filter((item) => Boolean(item.preview) || connection.running[item.id] === true)
        .sort((a, b) => b.updatedAt - a.updatedAt || b.createdAt - a.createdAt || a.id.localeCompare(b.id)),
    [connection.conversations, connection.running],
  );
  const names = useMemo(() => new Map(connection.projects.map((item) => [item.cwd, item.name])), [connection.projects]);
  // Projects that hold a listed chat, most recently active first (`listed` is already in that order).
  const projectCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const chat of listed) {
      if (chat.project && names.has(chat.project)) counts.set(chat.project, (counts.get(chat.project) ?? 0) + 1);
    }
    return counts;
  }, [listed, names]);
  const needle = query.trim().toLowerCase();
  const visible = listed.filter((item) => {
    if (project !== null && (item.project ?? "") !== project) return false;
    if (!needle) return true;
    return `${item.title} ${item.preview ?? ""} ${names.get(item.project ?? "") ?? ""}`.toLowerCase().includes(needle);
  });
  const waiting = visible.filter((item) => connection.waiting[item.id]);
  const running = visible.filter((item) => !connection.waiting[item.id] && connection.running[item.id]);
  const recent = visible.filter((item) => !connection.waiting[item.id] && !connection.running[item.id]);
  const rows: Array<{ kind: "header"; key: string; title: string } | { kind: "chat"; key: string; chat: CatalogConversation }> = [];
  if (waiting.length > 0) rows.push({ kind: "header", key: "h-waiting", title: "等你处理" }, ...waiting.map((c) => ({ kind: "chat" as const, key: c.id, chat: c })));
  if (running.length > 0) rows.push({ kind: "header", key: "h-running", title: "运行中" }, ...running.map((c) => ({ kind: "chat" as const, key: c.id, chat: c })));
  if (recent.length > 0) rows.push({ kind: "header", key: "h-recent", title: "最近" }, ...recent.map((c) => ({ kind: "chat" as const, key: c.id, chat: c })));

  async function createChat(): Promise<void> {
    const remote = getClient();
    if (!remote || creating) return;
    setCreating(true);
    try {
      const result = (await remote.call("conversations:create", { project: project ?? undefined, activate: false })) as { conversation?: { id?: string } };
      const conversationId = result.conversation?.id;
      if (conversationId) router.push(`/chat/${conversationId}`);
    } finally {
      setCreating(false);
    }
  }

  const ready = connection.status === "ready" && connection.server?.id === id;

  return (
    <View style={[styles.screen, { backgroundColor: palette.background }]}>
      <Stack.Screen
        options={{
          title: server?.alias || "设备",
          headerRight: ready
            ? () => (
                <Pressable onPress={() => void createChat()} hitSlop={8} disabled={creating}>
                  <Text style={{ color: palette.accent, fontSize: 17 }}>{creating ? "…" : "新对话"}</Text>
                </Pressable>
              )
            : undefined,
        }}
      />
      {!loaded ? (
        <View style={styles.center}>
          <BrandLoading palette={palette} message="正在加载设备" />
        </View>
      ) : null}
      {loaded && !server ? (
        <View style={styles.center}>
          <Text style={{ color: palette.muted }}>找不到这台设备</Text>
        </View>
      ) : null}
      {connection.status === "connecting" && connection.server?.id === id ? (
        <View style={styles.center}>
          <BrandLoading palette={palette} message={`正在连接 ${server?.host ?? "设备"}`} />
        </View>
      ) : null}
      {connection.server?.id === id && connection.status === "error" ? (
        <View style={styles.center}>
          <Text style={[styles.error, { color: palette.danger }]}>{connection.error}</Text>
          {connection.needsPassword ? (
            <View style={styles.login}>
              <TextInput
                value={password}
                onChangeText={setPassword}
                secureTextEntry
                placeholder="远程访问密码"
                placeholderTextColor={palette.muted}
                style={[styles.input, { color: palette.text, borderColor: palette.border }]}
              />
              <Pressable onPress={() => server && void loginSaved(server, password)} style={[styles.button, { backgroundColor: palette.accent }]}>
                <Text style={{ color: palette.accentText, fontSize: 16 }}>连接</Text>
              </Pressable>
            </View>
          ) : (
            <Pressable onPress={() => server && void connectSaved(server)} style={[styles.button, { backgroundColor: palette.accent }]}>
              <Text style={{ color: palette.accentText, fontSize: 16 }}>重试</Text>
            </Pressable>
          )}
        </View>
      ) : null}
      {ready ? (
        <View style={styles.listWrap}>
          <View style={styles.toolbar}>
            <View style={[styles.search, { backgroundColor: palette.card }]}>
              <HugeiconsIcon icon={Search01Icon} size={18} color={palette.muted} strokeWidth={2} />
              <TextInput
                value={query}
                onChangeText={setQuery}
                placeholder="搜索会话"
                placeholderTextColor={palette.muted}
                returnKeyType="search"
                style={[styles.searchInput, { color: palette.text }]}
              />
              {query ? (
                <Pressable onPress={() => setQuery("")} hitSlop={10} accessibilityLabel="清除搜索">
                  <HugeiconsIcon icon={Cancel01Icon} size={16} color={palette.muted} strokeWidth={2} />
                </Pressable>
              ) : null}
            </View>
            {projectCounts.size > 0 || project !== null ? (
              <ProjectFilter
                label={project === null ? "全部项目" : (names.get(project) ?? project)}
                active={project !== null}
                palette={palette}
                onPress={() => setPickingProject(true)}
                onClear={() => setProject(null)}
              />
            ) : null}
          </View>
          <FlatList
            data={rows}
            keyExtractor={(item) => item.key}
            contentContainerStyle={styles.list}
            keyboardShouldPersistTaps="handled"
            keyboardDismissMode="on-drag"
            ListEmptyComponent={
              <Text style={[styles.empty, { color: palette.muted }]}>
                {listed.length === 0 ? "还没有会话。点右上角开始一个。" : "没有匹配的会话"}
              </Text>
            }
            renderItem={({ item }) =>
              item.kind === "header" ? (
                <Text style={[styles.section, { color: palette.muted }]}>{item.title}</Text>
              ) : (
                <ConversationRow
                  conversation={item.chat}
                  projectName={project === null && item.chat.project ? names.get(item.chat.project) : undefined}
                  waiting={connection.waiting[item.chat.id] === true}
                  running={connection.running[item.chat.id] === true}
                  palette={palette}
                  onPress={() => router.push(`/chat/${item.chat.id}`)}
                />
              )
            }
          />
          <OptionSheet
            open={pickingProject}
            title="按项目筛选"
            groups={[
              {
                label: "",
                options: [
                  { value: ALL_PROJECTS, label: "全部项目", description: `${listed.length} 个会话` },
                  ...[...projectCounts].map(([cwd, count]) => ({ value: cwd, label: names.get(cwd) ?? cwd, description: `${count} 个会话` })),
                ],
              },
            ]}
            value={project ?? ALL_PROJECTS}
            onSelect={(value) => setProject(value === ALL_PROJECTS ? null : value)}
            onClose={() => setPickingProject(false)}
          />
        </View>
      ) : null}
    </View>
  );
}

function ConversationRow({
  conversation,
  projectName,
  waiting,
  running,
  palette,
  onPress,
}: {
  conversation: CatalogConversation;
  projectName?: string;
  waiting: boolean;
  running: boolean;
  palette: ReturnType<typeof usePalette>;
  onPress: () => void;
}): JSX.Element {
  return (
    <Pressable onPress={onPress} style={[styles.row, { backgroundColor: palette.card }]}>
      <View style={styles.rowTop}>
        {waiting ? <HugeiconsIcon icon={Alert02Icon} size={16} color={palette.warning} strokeWidth={2} /> : null}
        {running ? <DesktopSpinner size={16} color={palette.accent} /> : null}
        <Text style={[styles.title, { color: palette.text }]} numberOfLines={1}>
          {conversation.title}
        </Text>
        {projectName ? (
          <View style={[styles.projectBadge, { backgroundColor: palette.border }]}>
            <Text style={[styles.projectBadgeText, { color: palette.muted }]}>{projectName}</Text>
          </View>
        ) : null}
        <Text style={[styles.time, { color: palette.muted }]}>{relativeTime(conversation.updatedAt)}</Text>
      </View>
      <Text style={[styles.preview, { color: palette.muted }]} numberOfLines={2}>
        {conversation.preview || "没有预览"}
      </Text>
    </Pressable>
  );
}

/** The toolbar's project filter: one pill that opens a sheet, instead of a row of every project. */
function ProjectFilter({
  label,
  active,
  palette,
  onPress,
  onClear,
}: {
  label: string;
  active: boolean;
  palette: ReturnType<typeof usePalette>;
  onPress: () => void;
  onClear: () => void;
}): JSX.Element {
  const tint = active ? palette.accent : palette.muted;
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`按项目筛选：${label}`}
      style={({ pressed }) => [
        styles.filter,
        { backgroundColor: active ? `${palette.accent}1f` : palette.card, opacity: pressed ? 0.7 : 1 },
      ]}
    >
      <HugeiconsIcon icon={Folder01Icon} size={16} color={tint} strokeWidth={2} />
      <Text style={[styles.filterLabel, { color: active ? palette.accent : palette.text }]} numberOfLines={1}>
        {label}
      </Text>
      {active ? (
        <Pressable onPress={onClear} hitSlop={10} accessibilityLabel="清除项目筛选">
          <HugeiconsIcon icon={Cancel01Icon} size={14} color={tint} strokeWidth={2} />
        </Pressable>
      ) : (
        <HugeiconsIcon icon={ArrowDown01Icon} size={14} color={tint} strokeWidth={2} />
      )}
    </Pressable>
  );
}

function relativeTime(timestamp: number): string {
  const diff = Date.now() - timestamp;
  if (diff < 60_000) return "刚刚";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}小时前`;
  if (diff < 172_800_000) return "昨天";
  const date = new Date(timestamp);
  return `${date.getMonth() + 1}月${date.getDate()}日`;
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  center: { flex: 1, alignItems: "center", justifyContent: "center", gap: 12, padding: 24 },
  error: { fontSize: 15, lineHeight: 22, textAlign: "center" },
  login: { alignSelf: "stretch", gap: 10 },
  input: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 12, paddingHorizontal: 12, paddingVertical: 12, fontSize: 16 },
  button: { borderRadius: 12, paddingVertical: 12, alignItems: "center" },
  listWrap: { flex: 1 },
  toolbar: { flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 16, paddingTop: 12, paddingBottom: 4 },
  search: { flex: 1, flexDirection: "row", alignItems: "center", gap: 8, height: 40, borderRadius: 12, paddingHorizontal: 12 },
  searchInput: { flex: 1, height: 40, fontSize: 16, paddingVertical: 0 },
  filter: { flexDirection: "row", alignItems: "center", gap: 6, height: 40, maxWidth: "55%", borderRadius: 12, paddingHorizontal: 12 },
  filterLabel: { flexShrink: 1, fontSize: 15, fontWeight: "500" },
  list: { paddingHorizontal: 16, paddingTop: 8, paddingBottom: 16, gap: 8 },
  section: { fontSize: 13, fontWeight: "600", marginTop: 8, marginBottom: 4, marginLeft: 4 },
  row: { borderRadius: 14, padding: 14, gap: 6 },
  rowTop: { flexDirection: "row", alignItems: "center", gap: 8 },
  title: { fontSize: 16, fontWeight: "600", flex: 1 },
  projectBadge: { borderRadius: 6, paddingHorizontal: 6, paddingVertical: 2 },
  projectBadgeText: { fontSize: 11 },
  time: { fontSize: 12 },
  preview: { fontSize: 14, lineHeight: 20 },
  empty: { textAlign: "center", marginTop: 32, fontSize: 15 },
});
