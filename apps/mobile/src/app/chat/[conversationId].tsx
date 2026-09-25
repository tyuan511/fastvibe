import { Stack, useLocalSearchParams } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from "react";
import { FlatList, KeyboardAvoidingView, Platform, StyleSheet, Text, View } from "react-native";
import { HugeiconsIcon } from "@hugeicons/react-native";
import { ScissorIcon } from "../../ui/icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { currentConnection, getClient, onEngineEvent, resolvePendingPermission, useConnection, watchConversation } from "../../session/connection";
import { PermissionCard } from "../../ui/permission-card";
import { usePalette } from "../../ui/theme";
import { BrandLoading } from "../../ui/brand";
import { MarkdownView } from "../../chat/markdown";
import { ToolCard, type ToolBlock } from "../../chat/tool-card";
import { Composer } from "../../chat/composer";
import { QueuePanel } from "../../chat/queue-panel";
import { emptyQueue, mergeQueue, shouldHoldSend, shouldQueueMessage, submitMessage, SubmissionUncertainError } from "../../chat/queue";
import { DesktopSpinner } from "../../chat/desktop-spinner";
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
};

type MessagePart =
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

const MESSAGE_BOTTOM_GAP = 36;
const WORKING_PILL_HEIGHT = 28;
const WORKING_GAP = 8;
const WORKING_BOTTOM_INSET = 8;
const WORKING_SCROLL_SPACE = WORKING_PILL_HEIGHT + WORKING_GAP + WORKING_BOTTOM_INSET;

export default function ChatScreen() {
  const { conversationId } = useLocalSearchParams<{ conversationId: string }>();
  const palette = usePalette();
  const insets = useSafeAreaInsets();
  const connection = useConnection();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
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

  const applyQueue = useCallback((value: unknown) => {
    if (liveScope.current !== scope) return;
    const next = mergeQueue(queueRef.current, value);
    queueRef.current = next;
    setQueue(next);
  }, [scope]);

  const reload = useCallback(async () => {
    if (!scope.remote || !scope.conversationId) return;
    const snapshot = (await scope.remote.call("engine:get-snapshot", { conversationId: scope.conversationId })) as { messages?: unknown; queue?: unknown };
    if (liveScope.current !== scope) return;
    setMessages(Array.isArray(snapshot.messages) ? snapshot.messages.flatMap(parseMessage) : []);
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
        setError(typeof event.message === "string" ? event.message : "排队消息发送失败");
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
      if (event.type === "message_update") {
        const inner = isRecord(event.assistantMessageEvent) ? event.assistantMessageEvent : null;
        const delta = typeof inner?.delta === "string" ? inner.delta : "";
        if (inner?.type === "text_delta" && delta) {
          setMessages((current) => appendDelta(current, delta));
          return;
        }
      }
      if (event.type === "queue_delivered" || event.type === "agent_settled" || event.type === "message_end" || event.type === "tool_execution_end") {
        void reload().catch(() => undefined);
      }
    });
    void reload()
      .catch((caught: unknown) => {
        if (!cancelled) setError(caught instanceof Error ? caught.message : "读不到这个会话");
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
  const inverted = useMemo(() => messages.slice().reverse(), [messages]);
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
    setError(null);
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
      setError(caught instanceof Error ? caught.message : "没有发出去");
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
      if (liveScope.current === scope) setError(caught instanceof Error ? caught.message : "更新队列失败");
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
      setError(caught instanceof Error ? caught.message : "没有提交成功");
    } finally {
      setResponding(false);
    }
  }

  const last = messages.at(-1);
  const canContinue = !running && (Boolean(last?.error) || last?.stop === "aborted" || last?.stop === "length");
  const connected = Boolean(getClient());

  return (
    <View style={[styles.screen, { backgroundColor: palette.background }]}>
      <Stack.Screen options={{ title: chat?.title || "会话" }} />
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === "ios" ? "padding" : "height"}
        keyboardVerticalOffset={insets.top + 44}
      >
        {loading ? (
          <View style={styles.center}>
            <BrandLoading palette={palette} message="正在加载会话" />
          </View>
        ) : (
          <View style={styles.thread}>
            <FlatList
              data={inverted}
              inverted
              keyExtractor={(item) => item.id}
              contentContainerStyle={styles.messages}
              // With an inverted list, the header is at the visual bottom. Keep the
              // last message away from the composer, and reserve the larger space for
              // the floating status pill while a run is active.
              ListHeaderComponent={
                <View style={running && !prompt ? styles.workingSpacer : styles.messageBottomSpacer} />
              }
              keyboardShouldPersistTaps="handled"
              renderItem={({ item }) => (
                <MessageRow
                  message={item}
                  palette={palette}
                  meta={turnFooters.get(item.id)}
                />
              )}
            />
            {running && !prompt ? <WorkingStatus palette={palette} since={workingSince ?? clock} now={clock} /> : null}
          </View>
        )}
        {error ? <Text style={[styles.errorText, { color: palette.danger }]}>{error}</Text> : null}
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
            <PermissionCard prompt={prompt} busy={responding} onRespond={(payload) => void respond(payload)} />
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
    </View>
  );
}

function MessageRow({
  message,
  palette,
  meta,
}: {
  message: ChatMessage;
  palette: ReturnType<typeof usePalette>;
  meta?: TurnMeta;
}) {
  const mine = message.role === "user";
  if (message.kind === "compact") {
    return (
      <View style={styles.assistantRow}>
        <CompactNotice palette={palette} text={message.text} compact={message.compact} />
        {meta ? <TurnMetaLine meta={meta} palette={palette} /> : null}
      </View>
    );
  }
  const tools = new Map(message.tools.map((tool) => [tool.id, tool]));
  const body = message.parts?.length ? (
    message.parts.map((part, index) => {
      if (part.kind === "text") {
        return <MarkdownView key={`text-${index}`} text={part.text} palette={palette} />;
      }
      if (part.kind === "thinking") return null;
      if (part.kind === "tool") {
        const tool = tools.get(part.toolId);
        return tool ? <ToolCard key={part.toolId} tool={tool} palette={palette} /> : null;
      }
      if (part.kind === "compact") return <CompactNotice key={`compact-${index}`} palette={palette} text={part.text} compact={part.compact} />;
      if (part.kind === "model") return <Text key={`model-${index}`} style={[styles.modelDivider, { color: palette.muted }]}>模型已切换至 {part.to?.id ?? "新模型"}</Text>;
      return null;
    })
  ) : (
    <>
      {message.text ? <MarkdownView text={message.text} palette={palette} /> : null}
      {message.tools.map((tool) => <ToolCard key={tool.id} tool={tool} palette={palette} />)}
    </>
  );
  return (
    <View
      style={[
        mine ? styles.userBubble : styles.assistantRow,
        { backgroundColor: mine ? palette.card : "transparent", alignSelf: mine ? "flex-end" : "stretch" },
      ]}
    >
      {body}
      {message.error ? <Text style={{ color: palette.danger, fontSize: 14 }}>{message.error}</Text> : null}
      {meta ? <TurnMetaLine meta={meta} palette={palette} /> : null}
    </View>
  );
}

function TurnMetaLine({ meta, palette }: { meta: TurnMeta; palette: ReturnType<typeof usePalette> }): JSX.Element | null {
  const label = formatTurnMeta(meta);
  if (!label) return null;
  return <Text style={[styles.turnMeta, { color: palette.muted }]}>{label}</Text>;
}

function CompactNotice({ palette, text, compact }: { palette: ReturnType<typeof usePalette>; text: string; compact?: CompactInfo }): JSX.Element {
  const status = compact?.status ?? (text.trim() ? "done" : "running");
  const running = status === "running";
  const label = status === "running"
    ? "正在压缩上下文"
    : status === "aborted"
      ? "上下文压缩已取消"
      : status === "error"
        ? "压缩失败"
        : "上下文已压缩";
  const reason = compact?.reason === "threshold" ? "接近上限" : compact?.reason === "overflow" ? "超出窗口" : undefined;
  const tokens = compact?.tokensBefore !== undefined && compact.tokensAfter !== undefined
    ? `${formatTokenCount(compact.tokensBefore)} → ${formatTokenCount(compact.tokensAfter)}`
    : compact?.tokensBefore !== undefined
      ? formatTokenCount(compact.tokensBefore)
      : undefined;
  const color = status === "error" ? palette.danger : running ? palette.accent : palette.muted;
  const error = status === "error" ? compact?.error || text.trim() : undefined;
  return (
    <View style={styles.compactNotice}>
      <View style={styles.compactHeader}>
        {running ? <DesktopSpinner size={16} color={color} /> : <HugeiconsIcon icon={ScissorIcon} size={16} color={color} strokeWidth={2} />}
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

function WorkingStatus({ palette, since, now }: { palette: ReturnType<typeof usePalette>; since: number; now: number }): JSX.Element {
  return (
    <View pointerEvents="none" style={styles.working}>
      <View style={[styles.workingPill, { backgroundColor: palette.card, borderColor: palette.border }]}>
        <DesktopSpinner color={palette.muted} size={15} />
        <Text style={[styles.workingText, { color: palette.muted }]}>正在工作</Text>
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

function appendDelta(messages: ChatMessage[], delta: string): ChatMessage[] {
  const next = messages.slice();
  const last = next.at(-1);
  if (last && last.role === "assistant") {
    next[next.length - 1] = { ...last, text: last.text + delta };
    return next;
  }
  next.push({ id: `live-${Date.now()}`, role: "assistant", text: delta, tools: [], createdAt: Date.now() });
  return next;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  flex: { flex: 1 },
  thread: { flex: 1, minHeight: 0, position: "relative" },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  messages: { paddingHorizontal: 12, paddingVertical: 10, gap: 7 },
  messageBottomSpacer: { height: MESSAGE_BOTTOM_GAP },
  workingSpacer: { height: WORKING_SCROLL_SPACE },
  userBubble: { maxWidth: "82%", borderRadius: 12, paddingHorizontal: 12, paddingVertical: 8, gap: 4 },
  assistantRow: { width: "100%", maxWidth: 640, paddingVertical: 1, gap: 4 },
  turnMeta: { fontSize: 12, fontVariant: ["tabular-nums"] },
  compactNotice: { alignSelf: "stretch", paddingVertical: 4, gap: 3 },
  compactHeader: { flexDirection: "row", alignItems: "center", minWidth: 0, gap: 7 },
  compactLabel: { flexShrink: 0, fontSize: 14, fontWeight: "500" },
  compactMeta: { flexShrink: 1, fontSize: 12 },
  compactError: { paddingLeft: 23, fontSize: 13 },
  modelDivider: { alignSelf: "center", fontSize: 12, paddingVertical: 4 },
  errorText: { paddingHorizontal: 16, paddingBottom: 4, fontSize: 13 },
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
    gap: 6,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 999,
    paddingHorizontal: 11,
    shadowColor: "#000",
    shadowOpacity: 0.08,
    shadowRadius: 4,
    shadowOffset: { width: 0, height: 1 },
    elevation: 1,
  },
  workingText: { fontSize: 13, fontWeight: "600" },
  workingTime: { fontFamily: "monospace", fontSize: 12, opacity: 0.75 },
  prompt: { paddingHorizontal: 12 },
});
