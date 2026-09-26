import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { useEffect, useMemo, useState, type JSX } from "react";
import { FlatList, Pressable, RefreshControl, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { HugeiconsIcon } from "@hugeicons/react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  Alert02Icon,
  Archive02Icon,
  ArchiveArrowUpIcon,
  ArrowDown01Icon,
  ArrowRight01Icon,
  BubbleChatIcon,
  Cancel01Icon,
  ChatAdd01Icon,
  Delete02Icon,
  Folder01Icon,
  LockPasswordIcon,
  PencilEdit02Icon,
  Refresh01Icon,
  WifiDisconnected02Icon,
} from "../../ui/icons";
import {
  connectSaved,
  currentConnection,
  getClient,
  loginSaved,
  refreshConnection,
  useConnection,
  type CatalogConversation,
} from "../../session/connection";
import {
  archiveConversation,
  deleteConversation,
  renameConversation,
  unarchiveConversation,
} from "../../session/conversation-actions";
import { loadServers, type SavedServer } from "../../storage/servers";
import { elevation, radius, usePalette, type Palette } from "../../ui/theme";
import { dialog } from "../../ui/dialog";
import { toast } from "../../ui/toast";
import { BrandLoading } from "../../ui/brand";
import { Gradient } from "../../ui/gradient";
import { Sheet } from "../../ui/sheet";
import { Avatar, EmptyState, Pill, PrimaryButton, SearchField, SectionLabel } from "../../ui/kit";
import { haptic } from "../../ui/haptics";
import { relativeTime } from "../../ui/time";
import { DesktopSpinner } from "../../chat/desktop-spinner";
import { useT } from "../../i18n";
import { OptionSheet } from "../../chat/option-sheet";
import { listDrafts } from "../../chat/draft-storage";

/** The sheet's value for 「no project filter」; a cwd can never be empty. */
const ALL_PROJECTS = "";

type Row =
  | { kind: "header"; key: string; title: string; count: number }
  | { kind: "chat"; key: string; chat: CatalogConversation };

export default function ServerScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const palette = usePalette();
  const { t } = useT();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const connection = useConnection();
  const [server, setServer] = useState<SavedServer | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [password, setPassword] = useState("");
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<Map<string, string | undefined>>(new Map());
  const [project, setProject] = useState<string | null>(null);
  const [newProject, setNewProject] = useState(ALL_PROJECTS);
  const [creating, setCreating] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [pickingProject, setPickingProject] = useState(false);
  const [pickingNewProject, setPickingNewProject] = useState(false);
  const [menuChat, setMenuChat] = useState<CatalogConversation | null>(null);
  const [showArchived, setShowArchived] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoaded(false);
    void loadServers()
      .then((servers) => {
        if (cancelled) return;
        const found = servers.find((item) => item.id === id) ?? null;
        setServer(found);
        setLoaded(true);
        if (!found) return;
        const current = currentConnection();
        if (current.server?.id === found.id && (current.status === "ready" || current.status === "connecting")) return;
        void connectSaved(found);
      })
      .catch((error) => {
        if (cancelled) return;
        setLoaded(true);
        toast.failure(error, t("devices.loadFailed"));
      });
    return () => {
      cancelled = true;
    };
  }, [id]);

  const ready = connection.status === "ready" && connection.server?.id === id;

  // Titles and previews match on the phone; the transcript itself is searched on the
  // machine, which is the only place that holds it.
  useEffect(() => {
    const needle = query.trim();
    if (needle.length < 2 || !ready) {
      setHits(new Map());
      return undefined;
    }
    let live = true;
    const timer = setTimeout(() => {
      const remote = getClient();
      if (!remote) return;
      void remote
        .call("conversations:search", { query: needle })
        .then((result) => {
          if (!live || !Array.isArray(result)) return;
          const next = new Map<string, string | undefined>();
          for (const hit of result) {
            if (typeof hit === "object" && hit !== null && typeof (hit as { id?: unknown }).id === "string") {
              const snippet = (hit as { snippet?: unknown }).snippet;
              next.set((hit as { id: string }).id, typeof snippet === "string" ? snippet : undefined);
            }
          }
          setHits(next);
        })
        .catch(() => undefined);
    }, 280);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [query, ready]);

  const listed = useMemo(
    () =>
      connection.conversations
        .filter((item) => item.kind !== "side-chat" && !connection.archivedIds.includes(item.id))
        .filter((item) => Boolean(item.preview) || connection.running[item.id] === true)
        .sort((a, b) => b.updatedAt - a.updatedAt || b.createdAt - a.createdAt || a.id.localeCompare(b.id)),
    [connection.conversations, connection.running, connection.archivedIds],
  );
  const archived = useMemo(
    () =>
      connection.conversations
        .filter((item) => item.kind !== "side-chat" && connection.archivedIds.includes(item.id))
        .sort((a, b) => b.updatedAt - a.updatedAt),
    [connection.conversations, connection.archivedIds],
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
    if (hits.has(item.id)) return true;
    return `${item.title} ${item.preview ?? ""} ${names.get(item.project ?? "") ?? ""}`.toLowerCase().includes(needle);
  });
  const waiting = visible.filter((item) => connection.waiting[item.id]);
  const running = visible.filter((item) => !connection.waiting[item.id] && connection.running[item.id]);
  const recent = visible.filter((item) => !connection.waiting[item.id] && !connection.running[item.id]);
  const rows: Row[] = [];
  const section = (key: string, title: string, list: CatalogConversation[]) => {
    if (list.length === 0) return;
    rows.push({ kind: "header", key, title, count: list.length });
    for (const chat of list) rows.push({ kind: "chat", key: chat.id, chat });
  };
  section("h-waiting", t("server.waiting"), waiting);
  section("h-running", t("server.running"), running);
  section("h-recent", needle ? t("server.results") : t("server.recent"), recent);

  async function createChat(selectedProject: string): Promise<void> {
    const remote = getClient();
    if (!remote || creating) return;
    setCreating(true);
    try {
      // Match the desktop draft rule: if this project already has an empty chat with
      // text typed into it, 新对话 returns to that chat instead of losing the draft.
      const serverId = connection.server?.id;
      if (serverId) {
        const drafts = await listDrafts(serverId);
        const existing = drafts.find((draft) => {
          const chat = connection.conversations.find((item) => item.id === draft.conversationId);
          return chat && !chat.preview && (chat.project ?? "") === selectedProject;
        });
        if (existing) {
          router.push(`/chat/${existing.conversationId}`);
          return;
        }
      }
      const result = (await remote.call("conversations:create", {
        project: selectedProject || undefined,
        activate: false,
        reuseEmpty: false,
      })) as { conversation?: { id?: string } };
      const conversationId = result.conversation?.id;
      if (conversationId) router.push(`/chat/${conversationId}`);
    } catch (error) {
      toast.failure(error, t("server.createFailed"));
    } finally {
      setCreating(false);
    }
  }

  function startChat(): void {
    haptic.tap();
    // Nothing to choose between: go straight to the chat.
    if (connection.projects.length === 0) {
      void createChat(ALL_PROJECTS);
      return;
    }
    setNewProject(project ?? ALL_PROJECTS);
    setPickingNewProject(true);
  }

  function handleMenuAction(action: string): void {
    const chat = menuChat;
    setMenuChat(null);
    if (!chat) return;
    if (action === "rename") {
      dialog.prompt({
        title: t("common.renameChat"),
        initial: chat.title,
        onSubmit: (value) => {
          const title = value.trim();
          return title === chat.title ? undefined : renameConversation(chat.id, title);
        },
      });
    } else if (action === "archive") {
      void archiveChat(chat);
    } else if (action === "delete") {
      dialog.confirm({
        title: t("server.deleteChatTitle"),
        message: t("server.deleteChatBody", { title: chat.title }),
        confirmLabel: t("common.delete"),
        destructive: true,
        onConfirm: () => void deleteConversation(chat.id),
      });
    }
  }

  async function archiveChat(chat: CatalogConversation): Promise<void> {
    await archiveConversation(chat.id, connection.running[chat.id] === true);
  }

  async function unarchiveChat(chat: CatalogConversation): Promise<void> {
    await unarchiveConversation(chat.id);
  }

  async function refresh(): Promise<void> {
    setRefreshing(true);
    try {
      await refreshConnection();
    } catch {
      // A failed refresh leaves the last list; the header says whether we are connected.
    } finally {
      setRefreshing(false);
    }
  }

  const status = connection.server?.id !== id
    ? null
    : connection.status === "connecting"
      ? { label: t("server.statusConnecting"), color: palette.warning, soft: palette.warningSoft }
      : connection.status === "error"
        ? { label: t("server.statusOffline"), color: palette.danger, soft: palette.dangerSoft }
        : connection.reconnecting
          ? { label: t("server.statusReconnecting"), color: palette.warning, soft: palette.warningSoft }
          : connection.status === "ready"
            ? { label: t("server.statusConnected"), color: palette.success, soft: palette.successSoft }
            : null;

  const headerAlias = (
    <Text style={[styles.headerName, { color: palette.text }]} numberOfLines={1}>{server?.alias || t("common.device")}</Text>
  );
  const headerStatus = status ? (
    <View style={[styles.headerStatus, { backgroundColor: status.soft }]}>
      <View style={[styles.statusDot, { backgroundColor: status.color }]} />
      <Text style={[styles.headerStatusText, { color: status.color }]} numberOfLines={1}>{status.label}</Text>
    </View>
  ) : null;

  return (
    <View style={[styles.screen, { backgroundColor: palette.background }]}>
      <Stack.Screen
        options={{
          // Alias on the left beside the back button, connection state on the right;
          // the address is on the device list, and a title bar is no place to read it.
          // An empty title, or the alias showed twice. On iOS 26 the items go in as
          // `custom` with the shared glass background hidden — as a plain `headerLeft`
          // each sat in its own capsule; Android ignores the items and uses the rest.
          title: "",
          headerBackVisible: true,
          headerLeft: () => headerAlias,
          headerRight: headerStatus ? () => headerStatus : undefined,
          unstable_headerLeftItems: () => [{ type: "custom", element: headerAlias, hidesSharedBackground: true }],
          unstable_headerRightItems: () => (headerStatus ? [{ type: "custom", element: headerStatus, hidesSharedBackground: true }] : []),
        }}
      />
      {!loaded ? (
        <View style={styles.center}>
          <BrandLoading palette={palette} message={t("server.loadingDevice")} />
        </View>
      ) : null}
      {loaded && !server ? (
        <View style={styles.center}>
          <EmptyState icon={Alert02Icon} title={t("server.notFound")} body={t("server.notFoundBody")} palette={palette} />
        </View>
      ) : null}
      {connection.status === "connecting" && connection.server?.id === id ? (
        <View style={styles.center}>
          <BrandLoading palette={palette} message={t("server.connectingTo", { host: server?.host ?? t("common.device") })} />
        </View>
      ) : null}
      {connection.server?.id === id && connection.status === "error" ? (
        <View style={styles.center}>
          <View style={styles.failure}>
            <View style={[styles.failureIcon, { backgroundColor: connection.needsPassword ? palette.accentSoft : palette.dangerSoft }]}>
              <HugeiconsIcon
                icon={connection.needsPassword ? LockPasswordIcon : WifiDisconnected02Icon}
                size={30}
                color={connection.needsPassword ? palette.accent : palette.danger}
                strokeWidth={1.8}
              />
            </View>
            <Text style={[styles.failureTitle, { color: palette.text }]}>
              {connection.needsPassword ? t("server.needLogin") : t("server.cannotConnect", { name: server?.alias ?? t("common.device") })}
            </Text>
            <Text style={[styles.failureBody, { color: palette.muted }]}>
              {connection.needsPassword
                ? connection.error
                : t("server.cannotConnectBody", { error: (connection.error ?? t("server.connectFailed")).replace(/[。.]$/, ""), host: server?.host ?? t("server.thisDevice") })}
            </Text>
          </View>
          {connection.needsPassword ? (
            <View style={styles.actions}>
              <TextInput
                value={password}
                onChangeText={setPassword}
                secureTextEntry
                placeholder={t("add.passwordPlaceholder")}
                placeholderTextColor={palette.subtle}
                returnKeyType="go"
                onSubmitEditing={() => server && password && void loginSaved(server, password)}
                style={[styles.input, { color: palette.text, backgroundColor: palette.card }]}
              />
              <PrimaryButton label={t("server.connect")} palette={palette} disabled={!password} onPress={() => server && void loginSaved(server, password)} />
            </View>
          ) : (
            <View style={styles.actions}>
              <PrimaryButton label={t("server.reconnect")} icon={Refresh01Icon} palette={palette} onPress={() => server && void connectSaved(server)} />
            </View>
          )}
        </View>
      ) : null}
      {ready ? (
        <View style={styles.listWrap}>
          {connection.reconnecting ? (
            <View style={[styles.banner, { backgroundColor: palette.warningSoft }]}>
              <DesktopSpinner size={14} color={palette.warning} />
              <Text style={[styles.bannerText, { color: palette.warning }]}>{t("server.dropped")}</Text>
            </View>
          ) : null}
          <View style={styles.toolbar}>
            <SearchField value={query} onChange={setQuery} placeholder={t("server.searchPlaceholder")} palette={palette} style={styles.search} />
            {projectCounts.size > 0 || project !== null ? (
              <ProjectFilter
                label={project === null ? t("server.projectFilter") : (names.get(project) ?? project)}
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
            contentContainerStyle={[styles.list, { paddingBottom: insets.bottom + 96 }]}
            keyboardShouldPersistTaps="handled"
            keyboardDismissMode="on-drag"
            refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void refresh()} tintColor={palette.muted} colors={[palette.accent]} />}
            ListEmptyComponent={
              listed.length === 0 ? (
                <EmptyState icon={BubbleChatIcon} title={t("server.emptyTitle")} body={t("server.emptyBody")} palette={palette}>
                  <PrimaryButton label={t("server.startChat")} icon={ChatAdd01Icon} palette={palette} onPress={startChat} busy={creating} style={styles.emptyButton} />
                </EmptyState>
              ) : (
                <EmptyState icon={BubbleChatIcon} title={t("server.noMatchTitle")} body={needle ? t("server.noMatchQuery", { query: query.trim() }) : t("server.noChatsInProject")} palette={palette} />
              )
            }
            ListFooterComponent={
              archived.length > 0 && !needle ? (
                <Pressable
                  onPress={() => {
                    haptic.tap();
                    setShowArchived(true);
                  }}
                  style={({ pressed }) => [styles.archivedRow, { opacity: pressed ? 0.6 : 1 }]}
                >
                  <HugeiconsIcon icon={Archive02Icon} size={16} color={palette.muted} strokeWidth={2} />
                  <Text style={[styles.archivedText, { color: palette.muted }]}>{t("server.archivedCount", { count: archived.length })}</Text>
                  <HugeiconsIcon icon={ArrowRight01Icon} size={14} color={palette.subtle} strokeWidth={2} />
                </Pressable>
              ) : null
            }
            renderItem={({ item }) =>
              item.kind === "header" ? (
                <SectionLabel title={item.title} count={item.count} palette={palette} />
              ) : (
                <ConversationRow
                  conversation={item.chat}
                  projectName={project === null && item.chat.project ? names.get(item.chat.project) : undefined}
                  snippet={hits.get(item.chat.id)}
                  waiting={connection.waiting[item.chat.id] === true}
                  running={connection.running[item.chat.id] === true}
                  palette={palette}
                  onPress={() => {
                    haptic.tap();
                    router.push(`/chat/${item.chat.id}`);
                  }}
                  onLongPress={() => {
                    haptic.press();
                    setMenuChat(item.chat);
                  }}
                />
              )
            }
          />
          <Pressable
            onPress={startChat}
            disabled={creating}
            accessibilityRole="button"
            accessibilityLabel={t("common.newChat")}
            style={({ pressed }) => [styles.fab, { bottom: insets.bottom + 18, transform: [{ scale: pressed ? 0.95 : 1 }] }, elevation(palette, 2)]}
          >
            <Gradient colors={palette.brand} radius={radius.pill} style={styles.fabInner}>
              {creating ? <DesktopSpinner size={18} color="#ffffff" /> : <HugeiconsIcon icon={ChatAdd01Icon} size={20} color="#ffffff" strokeWidth={2} />}
              <Text style={styles.fabLabel}>{t("common.newChat")}</Text>
            </Gradient>
          </Pressable>
          <OptionSheet
            open={menuChat !== null}
            title={menuChat?.title ?? t("server.chatActions")}
            subtitle={menuChat?.project ? names.get(menuChat.project) : undefined}
            groups={[{ label: "", options: [
              { value: "rename", label: t("common.rename"), icon: PencilEdit02Icon },
              { value: "archive", label: t("common.archive"), icon: Archive02Icon },
              { value: "delete", label: t("common.delete"), icon: Delete02Icon, destructive: true },
            ] }]}
            value={null}
            onSelect={handleMenuAction}
            onClose={() => setMenuChat(null)}
          />
          <OptionSheet
            open={pickingProject}
            title={t("server.filterByProject")}
            groups={[
              {
                label: "",
                options: [
                  { value: ALL_PROJECTS, label: t("server.allProjects"), description: t("common.chatCount", { count: listed.length }), icon: Folder01Icon },
                  ...[...projectCounts].map(([cwd, count]) => ({ value: cwd, label: names.get(cwd) ?? cwd, description: t("common.chatCount", { count }), avatar: names.get(cwd) ?? cwd })),
                ],
              },
            ]}
            value={project ?? ALL_PROJECTS}
            onSelect={(value) => setProject(value === ALL_PROJECTS ? null : value)}
            onClose={() => setPickingProject(false)}
          />
          <OptionSheet
            open={pickingNewProject}
            title={t("common.newChat")}
            subtitle={t("server.whichProject")}
            groups={[
              {
                label: "",
                options: [
                  { value: ALL_PROJECTS, label: t("common.noProject"), description: t("common.useScratchWorkspace"), icon: BubbleChatIcon },
                  ...connection.projects.map((item) => ({ value: item.cwd, label: item.name, description: item.cwd, avatar: item.name })),
                ],
              },
            ]}
            value={newProject}
            onSelect={(value) => {
              setNewProject(value);
              void createChat(value);
            }}
            onClose={() => setPickingNewProject(false)}
          />
          <Sheet open={showArchived} onClose={() => setShowArchived(false)} title={t("server.archived")} subtitle={t("common.chatCount", { count: archived.length })} tall={archived.length > 5}>
            <ScrollView style={styles.archivedList} contentContainerStyle={styles.archivedContent}>
              {archived.length === 0 ? <Text style={[styles.archivedEmpty, { color: palette.muted }]}>{t("server.noArchived")}</Text> : null}
              {archived.map((chat) => (
                <View key={chat.id} style={[styles.archivedItem, { backgroundColor: palette.background }]}>
                  <Pressable
                    style={styles.archivedMain}
                    onPress={() => {
                      setShowArchived(false);
                      router.push(`/chat/${chat.id}`);
                    }}
                  >
                    <Text style={[styles.archivedTitle, { color: palette.text }]} numberOfLines={1}>{chat.title}</Text>
                    <Text style={[styles.archivedMeta, { color: palette.muted }]} numberOfLines={1}>
                      {[chat.project ? names.get(chat.project) : undefined, relativeTime(chat.updatedAt)].filter(Boolean).join(" · ")}
                    </Text>
                  </Pressable>
                  <Pressable
                    onPress={() => void unarchiveChat(chat)}
                    style={({ pressed }) => [styles.restore, { backgroundColor: palette.accentSoft, opacity: pressed ? 0.7 : 1 }]}
                  >
                    <HugeiconsIcon icon={ArchiveArrowUpIcon} size={15} color={palette.accent} strokeWidth={2} />
                    <Text style={[styles.restoreText, { color: palette.accent }]}>{t("common.restore")}</Text>
                  </Pressable>
                </View>
              ))}
            </ScrollView>
          </Sheet>
        </View>
      ) : null}
    </View>
  );
}

function ConversationRow({
  conversation,
  projectName,
  snippet,
  waiting,
  running,
  palette,
  onPress,
  onLongPress,
}: {
  conversation: CatalogConversation;
  projectName?: string;
  /** Where a transcript search matched, shown in place of the preview. */
  snippet?: string;
  waiting: boolean;
  running: boolean;
  palette: Palette;
  onPress: () => void;
  onLongPress: () => void;
}): JSX.Element {
  const { t } = useT();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${conversation.title}, ${snippet || conversation.preview || t("server.noPreview")}`}
      accessibilityHint={t("server.chatOpenHint")}
      onPress={onPress}
      onLongPress={onLongPress}
      delayLongPress={320}
      style={({ pressed }) => [
        styles.row,
        { backgroundColor: palette.card, borderColor: waiting ? palette.warning : "transparent", opacity: pressed ? 0.85 : 1 },
      ]}
    >
      {waiting ? (
        <View style={[styles.lead, { backgroundColor: palette.warningSoft }]}>
          <HugeiconsIcon icon={Alert02Icon} size={20} color={palette.warning} strokeWidth={2} />
        </View>
      ) : running ? (
        <View style={[styles.lead, { backgroundColor: palette.accentSoft }]}>
          <DesktopSpinner size={20} color={palette.accent} />
        </View>
      ) : projectName ? (
        <Avatar name={projectName} palette={palette} size={42} style={styles.leadAvatar} />
      ) : (
        <View style={[styles.lead, { backgroundColor: palette.field }]}>
          <HugeiconsIcon icon={BubbleChatIcon} size={20} color={palette.muted} strokeWidth={1.9} />
        </View>
      )}
      <View style={styles.rowBody}>
        <View style={styles.rowTop}>
          <Text style={[styles.title, { color: palette.text }]} numberOfLines={1}>
            {conversation.title}
          </Text>
          <Text style={[styles.time, { color: palette.subtle }]}>{relativeTime(conversation.updatedAt)}</Text>
        </View>
        <Text style={[styles.preview, { color: palette.muted }]} numberOfLines={2}>
          {snippet || conversation.preview || t("server.noPreview")}
        </Text>
        {waiting || running || projectName ? (
          <View style={styles.tags}>
            {waiting ? <Pill label={t("server.waiting")} tone="warning" palette={palette} /> : null}
            {running ? <Pill label={t("server.running")} tone="accent" palette={palette} /> : null}
            {projectName ? <Pill label={projectName} icon={Folder01Icon} palette={palette} /> : null}
          </View>
        ) : null}
      </View>
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
  palette: Palette;
  onPress: () => void;
  onClear: () => void;
}): JSX.Element {
  const { t } = useT();
  const tint = active ? palette.accent : palette.muted;
  return (
    <View style={[styles.filter, { backgroundColor: active ? palette.accentSoft : palette.field }]}>
      <Pressable
        onPress={onPress}
        accessibilityRole="button"
        accessibilityLabel={t("server.filterLabel", { label })}
        style={({ pressed }) => [styles.filterMain, { opacity: pressed ? 0.7 : 1 }]}
      >
        <HugeiconsIcon icon={Folder01Icon} size={16} color={tint} strokeWidth={2} />
        <Text style={[styles.filterLabel, { color: active ? palette.accent : palette.text }]} numberOfLines={1} ellipsizeMode="tail">
          {label}
        </Text>
        {!active ? <HugeiconsIcon icon={ArrowDown01Icon} size={14} color={tint} strokeWidth={2} /> : null}
      </Pressable>
      {active ? (
        <Pressable onPress={onClear} hitSlop={10} accessibilityRole="button" accessibilityLabel={t("server.clearFilter")}>
          <HugeiconsIcon icon={Cancel01Icon} size={14} color={tint} strokeWidth={2} />
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  headerName: { fontSize: 17, fontWeight: "700", maxWidth: 200, marginLeft: 4 },
  headerStatus: { flexDirection: "row", alignItems: "center", gap: 6, borderRadius: 999, paddingHorizontal: 10, paddingVertical: 5 },
  statusDot: { width: 7, height: 7, borderRadius: 4 },
  headerStatusText: { fontSize: 12, fontWeight: "700" },
  center: { flex: 1, alignItems: "center", justifyContent: "center", padding: 32 },
  failure: { alignItems: "center", gap: 8, maxWidth: 320 },
  failureIcon: { width: 68, height: 68, borderRadius: 22, alignItems: "center", justifyContent: "center", marginBottom: 8 },
  failureTitle: { fontSize: 19, fontWeight: "700", textAlign: "center" },
  failureBody: { fontSize: 14, lineHeight: 21, textAlign: "center" },
  actions: { width: "100%", maxWidth: 320, gap: 10, marginTop: 24 },
  input: { borderRadius: radius.md, paddingHorizontal: 14, height: 50, fontSize: 16 },
  listWrap: { flex: 1 },
  banner: { flexDirection: "row", alignItems: "center", gap: 8, marginHorizontal: 16, marginTop: 6, borderRadius: radius.md, paddingHorizontal: 12, paddingVertical: 8 },
  bannerText: { fontSize: 13, fontWeight: "600" },
  toolbar: { flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 16, paddingTop: 8, paddingBottom: 2 },
  search: { flex: 1 },
  // Fixed width: a long project name must not push the search field narrower.
  filter: { flexDirection: "row", alignItems: "center", gap: 6, width: 124, flexShrink: 0, height: 40, borderRadius: radius.md, paddingHorizontal: 11 },
  filterMain: { flex: 1, minWidth: 0, flexDirection: "row", alignItems: "center", gap: 6 },
  filterLabel: { flex: 1, fontSize: 14, fontWeight: "600" },
  list: { paddingHorizontal: 16, paddingTop: 2, gap: 8 },
  row: { borderRadius: radius.lg, padding: 12, gap: 12, flexDirection: "row", alignItems: "flex-start", borderWidth: 1 },
  lead: { width: 42, height: 42, borderRadius: 13, alignItems: "center", justifyContent: "center" },
  leadAvatar: { borderRadius: 13 },
  rowBody: { flex: 1, minWidth: 0, gap: 4 },
  rowTop: { flexDirection: "row", alignItems: "center", gap: 8 },
  title: { fontSize: 16, fontWeight: "700", flex: 1, letterSpacing: -0.2 },
  time: { fontSize: 12, fontWeight: "500" },
  preview: { fontSize: 14, lineHeight: 20 },
  tags: { flexDirection: "row", flexWrap: "wrap", gap: 6, marginTop: 2 },
  emptyButton: { marginTop: 14, alignSelf: "stretch" },
  archivedRow: { flexDirection: "row", alignItems: "center", gap: 6, paddingVertical: 18, paddingHorizontal: 4 },
  archivedText: { fontSize: 14, fontWeight: "600" },
  archivedList: { flexShrink: 1 },
  archivedContent: { paddingHorizontal: 16, paddingBottom: 12, gap: 8 },
  archivedEmpty: { textAlign: "center", paddingVertical: 24 },
  archivedItem: { flexDirection: "row", alignItems: "center", gap: 10, borderRadius: radius.md, paddingLeft: 14, paddingRight: 8, paddingVertical: 10 },
  archivedMain: { flex: 1, minWidth: 0, gap: 2 },
  archivedTitle: { fontSize: 15, fontWeight: "600" },
  archivedMeta: { fontSize: 12 },
  restore: { flexDirection: "row", alignItems: "center", gap: 4, borderRadius: radius.pill, paddingHorizontal: 11, paddingVertical: 7 },
  restoreText: { fontSize: 13, fontWeight: "700" },
  fab: { position: "absolute", right: 18, borderRadius: radius.pill },
  fabInner: { flexDirection: "row", alignItems: "center", gap: 8, height: 52, paddingHorizontal: 20 },
  fabLabel: { color: "#ffffff", fontSize: 16, fontWeight: "700" },
});
