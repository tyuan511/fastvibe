import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from "react";
import { FlatList, KeyboardAvoidingView, Platform, Pressable, StyleSheet, Text, View } from "react-native";
import * as Clipboard from "expo-clipboard";
import { HugeiconsIcon } from "@hugeicons/react-native";
import {
  Archive02Icon,
  ArrowDown02Icon,
  Bug01Icon,
  CodeIcon,
  Copy01Icon,
  Delete02Icon,
  Folder01Icon,
  Idea01Icon,
  MoreHorizontalIcon,
  PencilEdit02Icon,
  ScissorIcon,
  TestTube01Icon,
} from "../../ui/icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { currentConnection, getClient, onEngineEvent, reconnectNow, resolvePendingPermission, useConnection, watchConversation } from "../../session/connection";
import {
  archiveConversation,
  deleteConversation,
  permissionKey,
  rememberPermission,
  renameConversation,
} from "../../session/conversation-actions";
import { PermissionCard } from "../../ui/permission-card";
import { elevation, radius, usePalette, type Palette } from "../../ui/theme";
import { BrandLoading, BrandLogo } from "../../ui/brand";
import { IconButton } from "../../ui/kit";
import { dialog } from "../../ui/dialog";
import { toast } from "../../ui/toast";
import { haptic } from "../../ui/haptics";
import { MarkdownView } from "../../chat/markdown";
import { ProcessGroup, type ProcessItem, type ToolBlock } from "../../chat/tool-card";
import { Composer } from "../../chat/composer";
import { OptionSheet } from "../../chat/option-sheet";
import { QueuePanel } from "../../chat/queue-panel";
import { emptyQueue, mergeQueue, shouldHoldSend, shouldQueueMessage, submitMessage, SubmissionUncertainError } from "../../chat/queue";
import { DesktopSpinner } from "../../chat/desktop-spinner";
import { t, useT } from "../../i18n";
import { completedTurnFooters, formatTurnMeta, type TurnMeta } from "../../chat/turn-meta";

type ChatMessage = {
  id: string;
  role: string;
  text: string;
  thinking?: string;
  tools: ToolBlock[];
  error?: string;
  stop?: string;
  kind?: string;
  createdAt?: number;
  completedAt?: number;
  compact?: CompactInfo;
  parts?: MessagePart[];
  /** On a merged reply row (`mergeReplies`): the last message folded into it. */
  lastId?: string;
};

type MessagePart =
  | { kind: "error"; text: string }
  | { kind: "text"; text: string }
  | { kind: "thinking"; text: string }
  | { kind: "tool"; toolId: string }
  | { kind: "compact"; text: string; compact?: CompactInfo }
  | { kind: "model"; to?: { provider?: string; id?: string } };

type CompactInfo = {
  status?: "running" | "done" | "aborted" | "error";
  reason?: "manual" | "threshold" | "overflow";
  tokensBefore?: number;
  tokensAfter?: number;
  error?: string;
};

const MESSAGE_BOTTOM_GAP = 20;
const WORKING_PILL_HEIGHT = 30;
const WORKING_GAP = 8;
const WORKING_BOTTOM_INSET = 8;
const WORKING_SCROLL_SPACE = WORKING_PILL_HEIGHT + WORKING_GAP + WORKING_BOTTOM_INSET;

type SnapshotPayload = {
  messages?: unknown;
  queue?: unknown;
  messageMode?: "tail" | "full";
  messageAnchorId?: string;
};

export default function ChatScreen() {
  const { conversationId } = useLocalSearchParams<{ conversationId: string }>();
  const palette = usePalette();
  useT();
  const insets = useSafeAreaInsets();
  const connection = useConnection();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const messagesRef = useRef<ChatMessage[]>([]);
  messagesRef.current = messages;
  const [draft, setDraft] = useState("");
  const [loading, setLoading] = useState(true);
  const [responding, setResponding] = useState(false);
  const [sending, setSending] = useState(false);
  const [queue, setQueue] = useState(() => emptyQueue(conversationId));
  const queueRef = useRef(queue);
  const submitting = useRef<object | null>(null);
  const remote = getClient();
  // A reconnect is a new scope too: re-subscribe and re-read the durable queue.
  const scope = useMemo(() => ({ conversationId, remote }), [conversationId, remote]);
  const liveScope = useRef(scope);
  liveScope.current = scope;
  const [clock, setClock] = useState(() => Date.now());
  const chat = connection.conversations.find((item) => item.id === conversationId);
  const running = connection.running[conversationId] === true;
  const messageRunStartedAt = useMemo(() => currentRunStartedAt(messages), [messages]);
  const workingSince = messageRunStartedAt ?? connection.runningSince[conversationId];
  const prompt = connection.pending.find((item) => item.conversationId === conversationId);
  const router = useRouter();
  const listRef = useRef<FlatList<ChatMessage>>(null);
  const [menu, setMenu] = useState(false);
  const [picked, setPicked] = useState<ChatMessage | null>(null);
  const [away, setAway] = useState(false);
  const autoAnswered = useRef(new Set<string>());
  const projectName = chat?.project ? connection.projects.find((item) => item.cwd === chat.project)?.name : undefined;

  const applyQueue = useCallback((value: unknown) => {
    if (liveScope.current !== scope) return;
    const next = mergeQueue(queueRef.current, value);
    queueRef.current = next;
    setQueue(next);
  }, [scope]);

  const reload = useCallback(async () => {
    if (!scope.remote || !scope.conversationId) return;
    const current = messagesRef.current;
    const anchorEntryId = [...current].reverse().find((message) => message.role === "user")?.id;
    const snapshot = (await scope.remote.call("engine:get-snapshot", {
      conversationId: scope.conversationId,
      ...(anchorEntryId ? { fromEntryId: anchorEntryId } : {}),
    })) as SnapshotPayload;
    if (liveScope.current !== scope) return;
    const next = Array.isArray(snapshot.messages) ? snapshot.messages.flatMap(parseMessage) : [];
    const merged = snapshot.messageMode === "tail" && snapshot.messageAnchorId
      ? mergeMessageTail(current, next, snapshot.messageAnchorId)
      : null;
    setMessages(merged ?? next);
    applyQueue(snapshot.queue);
  }, [scope, applyQueue]);

  useEffect(() => {
    if (!running) return undefined;
    setClock(Date.now());
    const timer = setInterval(() => setClock(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [running]);

  useEffect(() => {
    let cancelled = false;
    queueRef.current = emptyQueue(conversationId);
    setQueue(queueRef.current);
    submitting.current = null;
    setSending(false);
    if (!scope.remote) {
      setLoading(false);
      return;
    }
    const stopWatch = watchConversation(conversationId);
    const stopEvents = onEngineEvent((event) => {
      if (event.conversationId !== conversationId) return;
      if (event.type === "queue_changed") {
        applyQueue(event.queue);
        return;
      }
      if (event.type === "queue_error") {
        toast.error(typeof event.message === "string" ? event.message : t("chat.queueFailed"));
      }
      if (event.type === "message_start") {
        const message = isRecord(event.message) ? event.message : null;
        if (message?.role === "assistant") {
          setMessages((current) => {
            const last = current.at(-1);
            if (!last || last.role !== "assistant" || (!last.text && !last.thinking && last.tools.length === 0)) return current;
            const startedAt = typeof message.createdAt === "number"
              ? message.createdAt
              : typeof event.createdAt === "number"
                ? event.createdAt
                : Date.now();
            return [...current, { id: `live-${Date.now()}`, role: "assistant", text: "", tools: [], createdAt: startedAt }];
          });
        }
      }
      if (
        event.type === "message_update" ||
        event.type === "tool_execution_start" ||
        event.type === "tool_execution_update" ||
        event.type === "tool_execution_end"
      ) {
        setMessages((current) => applyLiveEngineEvent(current, event));
      }
      if (event.type === "queue_delivered" || event.type === "agent_settled" || event.type === "message_end" || event.type === "tool_execution_end") {
        void reload().catch(() => undefined);
      }
    });
    void reload()
      .catch((caught: unknown) => {
        if (!cancelled) toast.failure(caught, t("chat.loadFailed"));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
      stopWatch();
      stopEvents();
    };
  }, [conversationId, scope, reload, applyQueue]);

  // Inverted list: index 0 is the newest message, rendered at the bottom. First paint
  // lands on it without any scroll animation — no more riding from the top.
  // One row per reply: the model's consecutive round trips read as one answer.
  const inverted = useMemo(() => mergeReplies(messages).reverse(), [messages]);
  // One finish line per settled turn, on its last row. The live turn keeps the
  // working capsule instead — a completion time is not knowable until it settles.
  const turnFooters = useMemo(() => completedTurnFooters(messages, running), [messages, running]);

  async function send(): Promise<void> {
    const text = draft.trim();
    const queueLoading = queueRef.current.revision < 0;
  if (!text || !remote || shouldHoldSend(Boolean(submitting.current), queueLoading)) return;
    const enqueue = shouldQueueMessage(currentConnection().running[conversationId] === true, queueRef.current);
    const reservation = {};
    submitting.current = reservation;
    const localId = `local-${Date.now()}`;
    setSending(true);
    setDraft("");
    try {
    const next = await submitMessage(remote, { conversationId, text, enqueue, previous: chat }, () => {
        if (liveScope.current === scope) setMessages((current) => [...current, { id: localId, role: "user", text, tools: [] }]);
      });
      if (next !== null) applyQueue(next);
    } catch (caught) {
      if (liveScope.current !== scope) return;
      if (!(caught instanceof SubmissionUncertainError)) {
        setMessages((current) => current.filter((item) => item.id !== localId));
        setDraft((current) => current || text);
      } else {
        void reload().catch(() => undefined);
      }
      toast.failure(caught, t("chat.sendFailed"));
    } finally {
      if (submitting.current === reservation) submitting.current = null;
      if (liveScope.current === scope) setSending(false);
    }
  }

  async function changeQueue(method: "engine:queue-cancel" | "engine:queue-resume", id?: string): Promise<void> {
    if (!remote) return;
    try {
      const next = await remote.call(method, id ? { id } : { conversationId });
      if (next !== null) applyQueue(next);
    } catch (caught) {
      if (liveScope.current === scope) toast.failure(caught, t("chat.queueUpdateFailed"));
    }
  }

  async function respond(payload: Record<string, unknown>): Promise<void> {
    const remote = getClient();
    if (!remote) return;
    setResponding(true);
    try {
      await remote.call("engine:permission-respond", payload);
      if (typeof payload.id === "string") resolvePendingPermission(payload.id);
    } catch (caught) {
      toast.failure(caught, t("chat.respondFailed"));
    } finally {
      setResponding(false);
    }
  }

  // A remembered 始终允许 is answered here too: the phone may be the only client
  // looking at a chat that runs in the background on the desktop.
  useEffect(() => {
    if (!prompt || prompt.method !== "confirm" || autoAnswered.current.has(prompt.id)) return;
    if (!connection.permissionAlways.includes(permissionKey(prompt))) return;
    autoAnswered.current.add(prompt.id);
    void respond({ id: prompt.id, confirmed: true });
    // `respond` is recreated each render and reads nothing that changes the answer.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prompt, connection.permissionAlways]);

  async function allowAlways(): Promise<void> {
    if (!prompt) return;
    try {
      await rememberPermission(prompt);
      toast.success(t("toast.alwaysAllowed"));
    } catch (caught) {
      toast.failure(caught, t("chat.rememberFailed"));
    }
    await respond({ id: prompt.id, confirmed: true });
  }

  function handleMenu(action: string): void {
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
    } else if (action === "copy") {
      const transcript = messages
        .filter((message) => message.kind !== "compact" && message.text.trim())
        .map((message) => `${message.role === "user" ? t("common.me") : "FastVibe"}:\n${message.text.trim()}`)
        .join("\n\n");
      void Clipboard.setStringAsync(transcript).then(() => toast.success(t("toast.chatCopied")));
    } else if (action === "archive") {
      void archiveConversation(chat.id, running).then((done) => done && router.back());
    } else if (action === "delete") {
      dialog.confirm({
        title: t("server.deleteChatTitle"),
        message: t("server.deleteChatBody", { title: chat.title }),
        confirmLabel: t("common.delete"),
        destructive: true,
        onConfirm: () => void deleteConversation(chat.id).then((done) => done && router.back()),
      });
    }
  }

  function handleMessageAction(action: string): void {
    const message = picked;
    if (!message) return;
    if (action === "copy") {
      void Clipboard.setStringAsync(message.text.trim()).then(() => toast.success(t("toast.copied")));
    } else if (action === "reuse") {
      setDraft(message.text.trim());
    }
  }

  const last = messages.at(-1);
  const canContinue = !running && (Boolean(last?.error) || last?.stop === "aborted" || last?.stop === "length");
  const connected = Boolean(getClient());

  const suggestions = [
    { icon: Idea01Icon, text: t("chat.suggest1") },
    { icon: Bug01Icon, text: t("chat.suggest2") },
    { icon: TestTube01Icon, text: t("chat.suggest3") },
    { icon: CodeIcon, text: t("chat.suggest4") },
  ];
  const empty = !loading && messages.length === 0 && !running;

  return (
    <View style={[styles.screen, { backgroundColor: palette.background }]}>
      <Stack.Screen
        options={{
          title: chat?.title || t("common.conversation"),
          headerTitle: () => (
            <View style={styles.headerTitle}>
              <View style={styles.headerRow}>
                {running ? <DesktopSpinner size={13} color={palette.accent} /> : null}
                <Text style={[styles.headerName, { color: palette.text }]} numberOfLines={1}>{chat?.title || t("common.conversation")}</Text>
              </View>
              {projectName ? (
                <View style={styles.headerRow}>
                  <HugeiconsIcon icon={Folder01Icon} size={11} color={palette.muted} strokeWidth={2} />
                  <Text style={[styles.headerSub, { color: palette.muted }]} numberOfLines={1}>{projectName}</Text>
                </View>
              ) : null}
            </View>
          ),
          headerRight: chat
            ? () => (
                <IconButton
                  icon={MoreHorizontalIcon}
                  label={t("server.chatActions")}
                  tone="field"
                  size={34}
                  palette={palette}
                  onPress={() => {
                    haptic.tap();
                    setMenu(true);
                  }}
                />
              )
            : undefined,
        }}
      />
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === "ios" ? "padding" : "height"}
        keyboardVerticalOffset={insets.top + 44}
      >
        {loading ? (
          <View style={styles.center}>
            <BrandLoading palette={palette} message={t("chat.loading")} />
          </View>
        ) : empty ? (
          <View style={styles.welcome}>
            <BrandLogo size={64} />
            <Text style={[styles.welcomeTitle, { color: palette.text }]}>{t("chat.welcomeTitle")}</Text>
            <Text style={[styles.welcomeBody, { color: palette.muted }]}>
              {projectName ? t("chat.welcomeInProject", { project: projectName }) : ""}{t("chat.welcomeBody")}
            </Text>
            <View style={styles.suggestions}>
              {suggestions.map((item) => (
                <Pressable
                  key={item.text}
                  onPress={() => {
                    haptic.select();
                    setDraft(item.text);
                  }}
                  style={({ pressed }) => [styles.suggestion, { backgroundColor: palette.card, opacity: pressed ? 0.75 : 1 }]}
                >
                  <View style={[styles.suggestionIcon, { backgroundColor: palette.accentSoft }]}>
                    <HugeiconsIcon icon={item.icon} size={16} color={palette.accent} strokeWidth={2} />
                  </View>
                  <Text style={[styles.suggestionText, { color: palette.text }]} numberOfLines={2}>{item.text}</Text>
                </Pressable>
              ))}
            </View>
          </View>
        ) : (
          <View style={styles.thread}>
            <FlatList
              ref={listRef}
              data={inverted}
              inverted
              keyExtractor={(item) => item.id}
              contentContainerStyle={styles.messages}
              onScroll={(event) => {
                const next = event.nativeEvent.contentOffset.y > 480;
                if (next !== away) setAway(next);
              }}
              scrollEventThrottle={64}
              // With an inverted list, the header is at the visual bottom. Keep the
              // last message away from the composer, and reserve the larger space for
              // the floating status pill while a run is active.
              ListHeaderComponent={
                <View style={running && !prompt ? styles.workingSpacer : styles.messageBottomSpacer} />
              }
              keyboardShouldPersistTaps="handled"
              renderItem={({ item, index }) => (
                <MessageRow
                  message={item}
                  palette={palette}
                  meta={turnFooters.get(item.lastId ?? item.id)}
                  turnStart={item.role === "assistant" && inverted[index + 1]?.role !== "assistant"}
                  live={running && index === 0}
                  onLongPress={() => {
                    if (!item.text.trim()) return;
                    haptic.press();
                    setPicked(item);
                  }}
                />
              )}
            />
            {running && !prompt ? <WorkingStatus palette={palette} since={workingSince ?? clock} now={clock} /> : null}
            {away ? (
              <Pressable
                accessibilityLabel={t("chat.jumpToLatest")}
                onPress={() => {
                  haptic.tap();
                  listRef.current?.scrollToOffset({ offset: 0, animated: true });
                }}
                style={({ pressed }) => [
                  styles.jump,
                  elevation(palette, 2),
                  { backgroundColor: palette.card, borderColor: palette.border, bottom: running && !prompt ? WORKING_SCROLL_SPACE + 4 : 12, opacity: pressed ? 0.7 : 1 },
                ]}
              >
                <HugeiconsIcon icon={ArrowDown02Icon} size={18} color={palette.text} strokeWidth={2} />
              </Pressable>
            ) : null}
          </View>
        )}
        {connection.reconnecting ? (
          <View style={[styles.reconnectBanner, { backgroundColor: palette.warningSoft, borderColor: palette.warning }]}>
            <DesktopSpinner size={14} color={palette.warning} />
            <Text style={[styles.reconnectText, { color: palette.text }]}>{t("chat.reconnecting")}</Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t("chat.reconnect")}
              onPress={() => {
                haptic.tap();
                reconnectNow();
              }}
              style={({ pressed }) => [styles.reconnectButton, { opacity: pressed ? 0.65 : 1 }]}
            >
              <Text style={[styles.reconnectButtonText, { color: palette.warning }]}>{t("chat.reconnect")}</Text>
            </Pressable>
          </View>
        ) : null}
        {queue.items.length > 0 ? (
          <QueuePanel
            queue={queue}
            disabled={!connected}
            onCancel={(id) => changeQueue("engine:queue-cancel", id)}
            onResume={() => changeQueue("engine:queue-resume")}
          />
        ) : null}
        {prompt ? (
          <View style={[styles.prompt, { paddingBottom: insets.bottom + 8 }]}>
            <PermissionCard
              key={prompt.id}
              prompt={prompt}
              busy={responding}
              onRespond={(payload) => void respond(payload)}
              onAlways={prompt.method === "confirm" ? () => void allowAlways() : undefined}
            />
          </View>
        ) : (
          <Composer
            conversationId={conversationId}
            running={running}
            sending={sending}
            queueing={running || queue.items.length > 0}
            disabled={!connected || queue.revision < 0}
            draft={draft}
            onDraftChange={setDraft}
            onSend={() => void send()}
            onAbort={() => void getClient()?.call("engine:abort", { conversationId })}
            onContinue={() => void getClient()?.call("engine:continue", { conversationId })}
            canContinue={canContinue}
          />
        )}
      </KeyboardAvoidingView>
      <OptionSheet
        open={menu}
        title={chat?.title ?? t("common.conversation")}
        subtitle={projectName}
        groups={[{
          label: "",
          options: [
            { value: "rename", label: t("common.rename"), icon: PencilEdit02Icon },
            { value: "copy", label: t("chat.copyAll"), icon: Copy01Icon },
            { value: "archive", label: t("common.archive"), icon: Archive02Icon },
            { value: "delete", label: t("common.delete"), icon: Delete02Icon, destructive: true },
          ],
        }]}
        value={null}
        onSelect={handleMenu}
        onClose={() => setMenu(false)}
      />
      <OptionSheet
        open={picked !== null}
        title={picked?.role === "user" ? t("chat.myMessage") : t("chat.reply")}
        subtitle={picked?.text.trim().replace(/\s+/g, " ").slice(0, 60)}
        groups={[{
          label: "",
          options: [
            { value: "copy", label: t("common.copy"), icon: Copy01Icon },
            ...(picked?.role === "user" ? [{ value: "reuse", label: t("chat.reuse"), description: t("chat.reuseHint"), icon: PencilEdit02Icon }] : []),
          ],
        }]}
        value={null}
        onSelect={handleMessageAction}
        onClose={() => setPicked(null)}
      />
    </View>
  );
}

function MessageRow({
  message,
  palette,
  meta,
  turnStart,
  live,
  onLongPress,
}: {
  message: ChatMessage;
  palette: Palette;
  meta?: TurnMeta;
  /** The first assistant row of a turn — it carries the reply's name. */
  turnStart: boolean;
  /** The newest row while a run is in flight. */
  live: boolean;
  onLongPress: () => void;
}) {
  useT();
  const mine = message.role === "user";
  if (message.kind === "compact") {
    return (
      <View style={styles.assistantRow}>
        <CompactNotice palette={palette} text={message.text} compact={message.compact} />
        {meta ? <TurnMetaLine meta={meta} palette={palette} /> : null}
      </View>
    );
  }
  if (mine) {
    return (
      <Pressable onLongPress={onLongPress} delayLongPress={300} style={styles.userWrap}>
        <View style={[styles.userBubble, { backgroundColor: palette.accentSoft }]}>
          {message.text ? <MarkdownView text={message.text} palette={palette} /> : null}
        </View>
        {message.error ? <Text style={[styles.messageError, { color: palette.danger }]}>{message.error}</Text> : null}
      </Pressable>
    );
  }
  const tools = new Map(message.tools.map((tool) => [tool.id, tool]));
  const blocks = buildBlocks(message, tools);
  return (
    <Pressable onLongPress={onLongPress} delayLongPress={350} style={styles.assistantRow}>
      {turnStart ? (
        <View style={styles.turnHead}>
          <BrandLogo size={20} />
          <Text style={[styles.turnName, { color: palette.text }]}>FastVibe</Text>
        </View>
      ) : null}
      {blocks.map((block, index) => {
        if (block.kind === "text") return <MarkdownView key={`text-${index}`} text={block.text} palette={palette} />;
        if (block.kind === "process") {
          return <ProcessGroup key={`process-${index}`} items={block.items} palette={palette} live={live && index === blocks.length - 1} />;
        }
        if (block.kind === "error") {
          return (
            <View key={`error-${index}`} style={[styles.messageErrorBox, { backgroundColor: palette.dangerSoft }]}>
              <Text style={[styles.messageError, { color: palette.danger }]}>{block.text}</Text>
            </View>
          );
        }
        if (block.kind === "compact") return <CompactNotice key={`compact-${index}`} palette={palette} text={block.text} compact={block.compact} />;
        return (
          <View key={`model-${index}`} style={styles.modelDivider}>
            <View style={[styles.modelLine, { backgroundColor: palette.border }]} />
            <Text style={[styles.modelText, { color: palette.muted }]} numberOfLines={1}>{t("chat.modelSwitched", { model: block.to ?? t("chat.newModel") })}</Text>
            <View style={[styles.modelLine, { backgroundColor: palette.border }]} />
          </View>
        );
      })}
      {message.error ? (
        <View style={[styles.messageErrorBox, { backgroundColor: palette.dangerSoft }]}>
          <Text style={[styles.messageError, { color: palette.danger }]}>{message.error}</Text>
        </View>
      ) : null}
      {meta ? <TurnMetaLine meta={meta} palette={palette} /> : null}
    </Pressable>
  );
}

type Block =
  | { kind: "text"; text: string }
  | { kind: "process"; items: ProcessItem[] }
  | { kind: "error"; text: string }
  | { kind: "compact"; text: string; compact?: CompactInfo }
  | { kind: "model"; to?: string };

/**
 * A reply's parts in order, with every stretch of thinking and tool calls folded into
 * one card. Only something the reader reads — prose, a compaction notice, a model
 * switch, an error — ends the stretch.
 */
function buildBlocks(message: ChatMessage, tools: Map<string, ToolBlock>): Block[] {
  const blocks: Block[] = [];
  const pushProcess = (item: ProcessItem) => {
    const previous = blocks.at(-1);
    if (previous?.kind === "process") previous.items.push(item);
    else blocks.push({ kind: "process", items: [item] });
  };
  for (const part of partsOf(message)) {
    if (part.kind === "text") {
      if (part.text.trim()) blocks.push({ kind: "text", text: part.text });
    } else if (part.kind === "thinking") {
      if (part.text.trim()) pushProcess({ kind: "thinking", text: part.text });
    } else if (part.kind === "tool") {
      const tool = tools.get(part.toolId);
      if (tool) pushProcess({ kind: "tool", tool });
    } else if (part.kind === "error") {
      blocks.push({ kind: "error", text: part.text });
    } else if (part.kind === "compact") {
      blocks.push({ kind: "compact", text: part.text, compact: part.compact });
    } else if (part.kind === "model") {
      blocks.push({ kind: "model", to: part.to?.id });
    }
  }
  return blocks;
}

/** A message's parts, synthesised in the old order for a message that carries none. */
function partsOf(message: ChatMessage): MessagePart[] {
  if (message.parts?.length) return message.parts;
  const parts: MessagePart[] = [];
  if (message.thinking?.trim()) parts.push({ kind: "thinking", text: message.thinking });
  if (message.text) parts.push({ kind: "text", text: message.text });
  for (const tool of message.tools) parts.push({ kind: "tool", toolId: tool.id });
  return parts;
}

/**
 * Fold each run of consecutive assistant messages — one per model round trip — into a
 * single row, so tool calls with no prose between them land in one card even when the
 * model made them in separate requests.
 *
 * The row keeps the *first* message's id: it is the list key, and a key that moved to
 * each new round trip would remount the row mid-run and close whatever the reader had
 * opened. `lastId` is what the turn footer is looked up by. An error from a round trip
 * that was not the last (a retried request) stays in place as its own part.
 */
function mergeReplies(messages: ChatMessage[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (const message of messages) {
    const previous = out.at(-1);
    const joinable = (item?: ChatMessage) => item?.role === "assistant" && item.kind !== "compact";
    if (!joinable(message) || !joinable(previous) || !previous) {
      out.push(message);
      continue;
    }
    const earlier = partsOf(previous);
    const parts: MessagePart[] = [...earlier, ...(previous.error ? [{ kind: "error" as const, text: previous.error }] : []), ...partsOf(message)];
    out[out.length - 1] = {
      ...message,
      id: previous.id,
      lastId: message.lastId ?? message.id,
      text: [previous.text, message.text].filter((text) => text.trim()).join("\n\n"),
      thinking: undefined,
      tools: [...previous.tools, ...message.tools],
      parts,
      createdAt: previous.createdAt ?? message.createdAt,
    };
  }
  return out;
}

function TurnMetaLine({ meta, palette }: { meta: TurnMeta; palette: Palette }): JSX.Element | null {
  const label = formatTurnMeta(meta);
  if (!label) return null;
  return <Text style={[styles.turnMeta, { color: palette.subtle }]}>{label}</Text>;
}

function CompactNotice({ palette, text, compact }: { palette: Palette; text: string; compact?: CompactInfo }): JSX.Element {
  const status = compact?.status ?? (text.trim() ? "done" : "running");
  const running = status === "running";
  const label = status === "running"
    ? t("chat.compacting")
    : status === "aborted"
      ? t("chat.compactCancelled")
      : status === "error"
        ? t("chat.compactFailed")
        : t("chat.compacted");
  const reason = compact?.reason === "threshold" ? t("chat.compactThreshold") : compact?.reason === "overflow" ? t("chat.compactOverflow") : undefined;
  const tokens = compact?.tokensBefore !== undefined && compact.tokensAfter !== undefined
    ? `${formatTokenCount(compact.tokensBefore)} → ${formatTokenCount(compact.tokensAfter)}`
    : compact?.tokensBefore !== undefined
      ? formatTokenCount(compact.tokensBefore)
      : undefined;
  const color = status === "error" ? palette.danger : running ? palette.accent : palette.muted;
  const error = status === "error" ? compact?.error || text.trim() : undefined;
  return (
    <View style={[styles.compactNotice, { backgroundColor: status === "error" ? palette.dangerSoft : running ? palette.accentSoft : palette.field }]}>
      <View style={styles.compactHeader}>
        {running ? <DesktopSpinner size={15} color={color} /> : <HugeiconsIcon icon={ScissorIcon} size={15} color={color} strokeWidth={2} />}
        <Text style={[styles.compactLabel, { color }]}>{label}</Text>
        {reason || tokens ? <Text style={[styles.compactMeta, { color: palette.muted }]} numberOfLines={1}>{[reason, tokens].filter(Boolean).join(" · ")}</Text> : null}
      </View>
      {error ? <Text style={[styles.compactError, { color: palette.danger }]} numberOfLines={2}>{error}</Text> : null}
    </View>
  );
}

function formatTokenCount(value: number): string {
  const absolute = Math.abs(value);
  if (absolute >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (absolute >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return String(Math.round(value));
}

function parseCompact(value: unknown): CompactInfo | undefined {
  const record = isRecord(value) ? value : null;
  if (!record) return undefined;
  const statuses = ["running", "done", "aborted", "error"] as const;
  const reasons = ["manual", "threshold", "overflow"] as const;
  return {
    status: typeof record.status === "string" && statuses.includes(record.status as "running" | "done" | "aborted" | "error") ? record.status as "running" | "done" | "aborted" | "error" : undefined,
    reason: typeof record.reason === "string" && reasons.includes(record.reason as "manual" | "threshold" | "overflow") ? record.reason as "manual" | "threshold" | "overflow" : undefined,
    tokensBefore: typeof record.tokensBefore === "number" ? record.tokensBefore : undefined,
    tokensAfter: typeof record.tokensAfter === "number" ? record.tokensAfter : undefined,
    error: typeof record.error === "string" ? record.error : undefined,
  };
}

function WorkingStatus({ palette, since, now }: { palette: Palette; since: number; now: number }): JSX.Element {
  return (
    <View pointerEvents="none" style={styles.working}>
      <View style={[styles.workingPill, elevation(palette, 0), { backgroundColor: palette.card, borderColor: palette.border }]}>
        <DesktopSpinner color={palette.accent} size={15} />
        <Text style={[styles.workingText, { color: palette.text }]}>{t("chat.working")}</Text>
        <Text style={[styles.workingTime, { color: palette.muted }]}>{formatElapsed(now - since)}</Text>
      </View>
    </View>
  );
}

function currentRunStartedAt(messages: ChatMessage[]): number | undefined {
  let lastUser = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].role === "user") {
      lastUser = index;
      break;
    }
  }
  for (let index = lastUser + 1; index < messages.length; index += 1) {
    const message = messages[index];
    if (message.role === "assistant" && message.createdAt !== undefined) return message.createdAt;
  }
  return undefined;
}

function formatElapsed(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = seconds % 60;
  if (hours > 0) return `${hours}:${String(minutes).padStart(2, "0")}:${String(rest).padStart(2, "0")}`;
  return `${String(minutes).padStart(2, "0")}:${String(rest).padStart(2, "0")}`;
}

function parseMessage(value: unknown): ChatMessage[] {
  if (!isRecord(value) || typeof value.id !== "string") return [];
  const tools = Array.isArray(value.tools)
    ? value.tools.flatMap((tool) => {
        if (!isRecord(tool) || typeof tool.name !== "string") return [];
        return [{
          id: typeof tool.id === "string" ? tool.id : `tool-${Math.random()}`,
          name: tool.name,
          args: tool.args,
          result: typeof tool.result === "string" ? tool.result : undefined,
          status: typeof tool.status === "string" ? tool.status : undefined,
          details: tool.details,
        }];
      })
    : [];
  return [{
    id: value.id,
    role: typeof value.role === "string" ? value.role : "assistant",
    text: typeof value.text === "string" ? value.text : "",
    createdAt: typeof value.createdAt === "number" ? value.createdAt : undefined,
    completedAt: typeof value.completedAt === "number" ? value.completedAt : undefined,
    thinking: typeof value.thinking === "string" ? value.thinking : undefined,
    compact: parseCompact(value.compact),
    tools,
    parts: parseParts(value.parts),
    error: typeof value.error === "string" ? value.error : undefined,
    stop: typeof value.stop === "string" ? value.stop : undefined,
    kind: typeof value.kind === "string" ? value.kind : undefined,
  }];
}

function parseParts(value: unknown): MessagePart[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const parts = value.flatMap((part): MessagePart[] => {
    if (!isRecord(part) || typeof part.kind !== "string") return [];
    if (part.kind === "text" && typeof part.text === "string") return [{ kind: "text", text: part.text }];
    if (part.kind === "thinking" && typeof part.text === "string") return [{ kind: "thinking", text: part.text }];
    if (part.kind === "tool" && typeof part.toolId === "string") return [{ kind: "tool", toolId: part.toolId }];
    if (part.kind === "compact" && typeof part.text === "string") return [{ kind: "compact", text: part.text, compact: parseCompact(part.compact) }];
    if (part.kind === "model") return [{ kind: "model", to: isRecord(part.to) ? { provider: typeof part.to.provider === "string" ? part.to.provider : undefined, id: typeof part.to.id === "string" ? part.to.id : undefined } : undefined }];
    return [];
  });
  return parts.length > 0 ? parts : undefined;
}

function mergeMessageTail(current: ChatMessage[], tail: ChatMessage[], anchorId: string): ChatMessage[] | null {
  const anchorIndex = current.findIndex((message) => message.id === anchorId);
  if (anchorIndex < 0 || tail[0]?.id !== anchorId) return null;
  return [...current.slice(0, anchorIndex), ...tail];
}

function applyLiveEngineEvent(messages: ChatMessage[], event: Record<string, unknown>): ChatMessage[] {
  const inner = event.type === "message_update" && isRecord(event.assistantMessageEvent)
    ? event.assistantMessageEvent
    : null;
  const type = typeof inner?.type === "string" ? inner.type : event.type;

  if (type === "text_delta" || type === "thinking_delta") {
    const delta = typeof inner?.delta === "string" ? inner.delta : typeof inner?.text === "string" ? inner.text : "";
    if (!delta) return messages;
    const { list, index } = ensureLiveAssistant(messages);
    const current = list[index];
    const parts = [...(current.parts ?? [])];
    const kind = type === "text_delta" ? "text" : "thinking";
    const previous = parts.at(-1);
    if (previous?.kind === kind) parts[parts.length - 1] = { ...previous, text: previous.text + delta };
    else parts.push({ kind, text: delta });
    list[index] = {
      ...current,
      text: type === "text_delta" ? current.text + delta : current.text,
      thinking: type === "thinking_delta" ? `${current.thinking ?? ""}${delta}` : current.thinking,
      parts,
    };
    return list;
  }

  if (type === "toolcall_start" || type === "tool_call_start" || type === "toolcall_delta" || type === "tool_call_delta" || type === "toolcall_end" || type === "tool_call_end") {
    const block = partialToolBlock(inner);
    const { list, index } = ensureLiveAssistant(messages);
    const current = list[index];
    const id = resolveLiveToolId(current, stringValue(block?.id) ?? stringValue(inner?.id));
    return upsertLiveTool(list, index, {
      id,
      name: stringValue(block?.name) ?? stringValue(inner?.name),
      args: block?.arguments ?? block?.input ?? inner?.arguments ?? inner?.args ?? inner?.input,
      result: type === "toolcall_end" || type === "tool_call_end" ? stringifyToolValue(inner?.result ?? inner?.output) : undefined,
      status: "running",
    });
  }

  if (type === "tool_execution_start" || type === "tool_execution_update" || type === "tool_execution_end") {
    if (type !== "tool_execution_start" && !messages.some((message) => message.role === "assistant")) return messages;
    const { list, index } = ensureLiveAssistant(messages);
    const current = list[index];
    const id = resolveLiveToolId(current, stringValue(event.toolCallId) ?? stringValue(event.id));
    const name = stringValue(event.toolName) ?? stringValue(event.name);
    const details = event.details;
    const result = stringifyToolValue(event.partialResult ?? event.result ?? event.output);
    return upsertLiveTool(list, index, {
      id,
      name,
      args: event.args ?? event.arguments,
      result,
      details,
      status: type === "tool_execution_end" ? (event.isError === true ? "error" : "done") : "running",
    });
  }

  return messages;
}

type LiveToolPatch = {
  id: string;
  name?: string;
  args?: unknown;
  result?: string;
  details?: unknown;
  status: string;
};

function ensureLiveAssistant(messages: ChatMessage[]): { list: ChatMessage[]; index: number } {
  const list = messages.slice();
  const index = list.length - 1;
  const last = list[index];
  if (last?.role === "assistant") {
    list[index] = { ...last, tools: [...last.tools], parts: last.parts ? [...last.parts] : [] };
    return { list, index };
  }
  list.push({ id: `live-${Date.now()}`, role: "assistant", text: "", tools: [], parts: [], createdAt: Date.now() });
  return { list, index: list.length - 1 };
}

function upsertLiveTool(list: ChatMessage[], index: number, patch: LiveToolPatch): ChatMessage[] {
  const message = list[index];
  const tools = [...message.tools];
  const existingIndex = tools.findIndex((tool) => tool.id === patch.id);
  if (existingIndex === -1) {
    tools.push({ id: patch.id, name: patch.name || "tool", args: patch.args, result: patch.result, status: patch.status, details: patch.details });
    list[index] = { ...message, tools, parts: [...(message.parts ?? []), { kind: "tool", toolId: patch.id }] };
    return list;
  }
  const existing = tools[existingIndex];
  tools[existingIndex] = {
    ...existing,
    ...(patch.name ? { name: patch.name } : {}),
    ...(patch.args !== undefined ? { args: patch.args } : {}),
    ...(patch.result !== undefined ? { result: patch.result } : {}),
    ...(patch.details !== undefined ? { details: patch.details } : {}),
    status: patch.status || existing.status,
  };
  list[index] = { ...message, tools };
  return list;
}

function partialToolBlock(inner: Record<string, unknown> | null): Record<string, unknown> | undefined {
  if (!inner || !isRecord(inner.partial) || !Array.isArray(inner.partial.content)) return undefined;
  const index = typeof inner.contentIndex === "number" ? inner.contentIndex : inner.partial.content.length - 1;
  const block = inner.partial.content[index];
  return isRecord(block) ? block : undefined;
}

function resolveLiveToolId(message: ChatMessage, candidate: string | undefined): string {
  if (candidate) return candidate;
  return [...message.tools].reverse().find((tool) => tool.status === "running")?.id ?? `tool-${Date.now()}`;
}

function stringifyToolValue(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return undefined;
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  flex: { flex: 1 },
  headerTitle: { maxWidth: 230 },
  headerRow: { flexDirection: "row", alignItems: "center", gap: 5 },
  headerName: { fontSize: 16, fontWeight: "700", flexShrink: 1 },
  headerSub: { fontSize: 12, fontWeight: "500", flexShrink: 1 },
  thread: { flex: 1, minHeight: 0, position: "relative" },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  welcome: { flex: 1, alignItems: "center", justifyContent: "center", paddingHorizontal: 24, gap: 8 },
  welcomeTitle: { fontSize: 22, fontWeight: "800", letterSpacing: -0.4, marginTop: 10 },
  welcomeBody: { fontSize: 14, lineHeight: 21, textAlign: "center", maxWidth: 300 },
  suggestions: { alignSelf: "stretch", gap: 8, marginTop: 18 },
  suggestion: { flexDirection: "row", alignItems: "center", gap: 12, borderRadius: radius.lg, paddingHorizontal: 12, paddingVertical: 12 },
  suggestionIcon: { width: 32, height: 32, borderRadius: 10, alignItems: "center", justifyContent: "center" },
  suggestionText: { flex: 1, fontSize: 15, fontWeight: "500" },
  messages: { paddingHorizontal: 14, paddingVertical: 10, gap: 12 },
  messageBottomSpacer: { height: MESSAGE_BOTTOM_GAP },
  workingSpacer: { height: WORKING_SCROLL_SPACE },
  reconnectBanner: { flexDirection: "row", alignItems: "center", gap: 8, marginHorizontal: 10, marginBottom: 6, borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.md, paddingHorizontal: 11, paddingVertical: 8 },
  reconnectText: { flex: 1, fontSize: 13, fontWeight: "600" },
  reconnectButton: { paddingHorizontal: 4, paddingVertical: 3 },
  reconnectButtonText: { fontSize: 13, fontWeight: "700" },
  userWrap: { alignSelf: "flex-end", maxWidth: "86%", alignItems: "flex-end", gap: 4 },
  userBubble: { borderRadius: 20, borderBottomRightRadius: 6, paddingHorizontal: 14, paddingVertical: 6 },
  assistantRow: { width: "100%", maxWidth: 680, gap: 6 },
  turnHead: { flexDirection: "row", alignItems: "center", gap: 7, marginBottom: 2 },
  turnName: { fontSize: 14, fontWeight: "700" },
  turnMeta: { fontSize: 12, fontVariant: ["tabular-nums"] },
  messageError: { fontSize: 14, lineHeight: 20 },
  messageErrorBox: { borderRadius: radius.md, paddingHorizontal: 12, paddingVertical: 9 },
  compactNotice: { alignSelf: "stretch", borderRadius: radius.md, paddingHorizontal: 12, paddingVertical: 9, gap: 3 },
  compactHeader: { flexDirection: "row", alignItems: "center", minWidth: 0, gap: 7 },
  compactLabel: { flexShrink: 0, fontSize: 14, fontWeight: "600" },
  compactMeta: { flexShrink: 1, fontSize: 12 },
  compactError: { paddingLeft: 22, fontSize: 13 },
  modelDivider: { flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 4 },
  modelLine: { flex: 1, height: StyleSheet.hairlineWidth },
  modelText: { fontSize: 12, fontWeight: "500", flexShrink: 1 },
  jump: {
    position: "absolute",
    right: 14,
    width: 38,
    height: 38,
    borderRadius: 19,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: "center",
    justifyContent: "center",
  },
  working: {
    position: "absolute",
    right: 0,
    bottom: WORKING_BOTTOM_INSET,
    left: 0,
    alignItems: "center",
  },
  workingPill: {
    height: WORKING_PILL_HEIGHT,
    flexDirection: "row",
    alignItems: "center",
    gap: 7,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 999,
    paddingHorizontal: 12,
  },
  workingText: { fontSize: 13, fontWeight: "700" },
  workingTime: { fontFamily: "monospace", fontSize: 12, fontVariant: ["tabular-nums"] },
  prompt: { paddingHorizontal: 10, paddingTop: 4 },
});
