import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { FlatList, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { HugeiconsIcon } from "@hugeicons/react-native";
import { dagGraphState, dagNodeFinished, DAG_PREVIEW_CHARS, type DagGraph, type DagNode, type DagOutputPage } from "../../../../src/shared/dag";
import { dagProgress, dagTaskRows } from "../../../../src/shared/dag-view";
import { getClient, onEngineEvent, useConnection } from "../session/connection";
import { Sheet } from "../ui/sheet";
import { BotIcon, ArrowRight01Icon } from "../ui/icons";
import { usePalette, type Palette } from "../ui/theme";
import { toast } from "../ui/toast";
import { t, useT } from "../i18n";
import { MarkdownView } from "./markdown";
import { ProcessGroup, type ProcessItem, type ToolBlock } from "./tool-card";
import { DesktopSpinner } from "./desktop-spinner";
import { DagContext } from "./dag-context";
import { watchMobileDag } from "./dag-data";

type ChatMessage = {
  id: string; role: string; text?: string; thinking?: string; error?: string; tools?: ToolBlock[];
  parts?: Array<{ kind: "text" | "thinking"; text: string } | { kind: "tool"; toolId: string }>;
};
type Client = NonNullable<ReturnType<typeof getClient>>;
const SummaryContext = createContext<{ graph: DagGraph | null; open: () => void; connected: boolean } | null>(null);

export function MobileDagProvider({ conversationId, children }: { conversationId: string; children: ReactNode }) {
  const palette = usePalette(); useT();
  const connection = useConnection();
  const remote = getClient();
  const [graph, setGraph] = useState<DagGraph | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<string>();
  const [tab, setTab] = useState<"detail" | "run">("detail");
  const [busy, setBusy] = useState(false);
  const watcher = useRef<ReturnType<typeof watchMobileDag> | null>(null);
  const scope = useMemo(() => ({ conversationId, remote }), [conversationId, remote]);
  const current = useRef(scope); current.current = scope;
  useEffect(() => {
    setError(false); setLoading(!graph && Boolean(remote)); setBusy(false);
    if (!remote) return;
    const watch = watchMobileDag({ call: (method, payload) => remote.call(method, payload), onEvent: onEngineEvent }, conversationId,
      (next) => { if (current.current !== scope) return; setGraph(next); setLoading(false); setError(false); },
      () => { if (current.current !== scope) return; setLoading(false); setError(true); });
    watcher.current = watch;
    return () => { watcher.current = null; watch.dispose(); };
  }, [scope]);
  const show = useCallback((nodeId?: string) => { setSelected(nodeId); setTab("detail"); setOpen(true); }, []);
  const node = graph?.nodes.find((item) => item.id === selected);
  const parent = node?.parentId ? graph?.nodes.find((item) => item.id === node.parentId) : undefined;
  const canRetry = !node?.parentId || (parent?.status === "running" && (!node.parentRunId || node.parentRunId === parent.runId));
  const rows = useMemo(() => dagTaskRows(graph?.nodes ?? []), [graph]);
  const progress = dagProgress(graph?.nodes ?? []);
  const state = dagGraphState(graph?.nodes ?? []);
  async function action(method: "dag:cancel" | "dag:retry" | "dag:resume", id?: string) {
    if (!remote || busy) return;
    setBusy(true);
    try {
      await remote.call(method, { conversationId, ...(id ? method === "dag:cancel" ? { ids: [id] } : { id } : {}) });
      if (current.current === scope) await watcher.current?.refresh();
    } catch (cause) { if (current.current === scope) toast.error(cause instanceof Error ? cause.message : t("dag.actionFailed")); }
    finally { if (current.current === scope) setBusy(false); }
  }
  const disabled = busy || connection.status !== "ready";
  const navigation = useMemo(() => ({ open: show }), [show]);
  return (
    <DagContext.Provider value={navigation}>
      <SummaryContext.Provider value={{ graph, open: () => show(), connected: connection.status === "ready" }}>
        {children}
        <Sheet open={open} onClose={() => setOpen(false)} tall title={node ? `${node.id} · ${node.title}` : t("dag.title")}
          subtitle={node ? node.profile.name : t("dag.progress", { done: progress.completed, total: progress.total })}
          headerRight={selected ? <Action label={t("dag.back")} onPress={() => setSelected(undefined)} palette={palette} /> : undefined}>
          {node ? (
            <View style={styles.flex}>
              <View style={[styles.tabs, { borderColor: palette.separator }]}>
                <Action label={t("dag.detail")} onPress={() => setTab("detail")} palette={palette} active={tab === "detail"} />
                <Action label={t("dag.execution")} onPress={() => setTab("run")} palette={palette} active={tab === "run"} disabled={!node.runId} />
                {tab === "run" && node.status === "running" ? <Action label={t("dag.stop")} palette={palette} disabled={disabled} onPress={() => void action("dag:cancel", node.id)} /> : null}
              </View>
              {tab === "run" && node.runId ? remote ? <RunTranscript key={`${node.id}:${node.runId}`} client={remote} node={node} conversationId={conversationId} palette={palette} /> : <View style={styles.empty}><Text style={{ color: palette.muted }}>{t("dag.offline")}</Text></View> : (
                <ScrollView contentContainerStyle={styles.detail}>
                  <View style={styles.actions}><Status node={node} palette={palette} />{node.coordinator ? <Text style={{ color: palette.muted }}>{t("dag.coordinator")}</Text> : null}
                    {node.attempt ? <Text style={{ color: palette.muted }}>{t("dag.attempt", { count: node.attempt })}</Text> : null}</View>
                  <View style={styles.actions}>
                    {node.status === "running" || node.status === "pending" ? <Action label={t("dag.stop")} disabled={disabled} onPress={() => void action("dag:cancel", node.id)} palette={palette} /> : null}
                    {canRetry && (node.status === "blocked" || node.status === "failed" || node.status === "cancelled") ? <Action label={t("dag.retry")} disabled={disabled} onPress={() => void action("dag:retry", node.id)} palette={palette} /> : null}
                  </View>
                  {node.error ? <Text selectable style={[styles.error, { color: palette.danger, backgroundColor: palette.dangerSoft }]}>{node.error}</Text> : null}
                  {node.parentId ? <Links label={t("dag.parent")} ids={[node.parentId]} graph={graph!} select={show} palette={palette} /> : null}
                  <Links label={t("dag.dependencies")} ids={node.dependsOn} graph={graph!} select={show} palette={palette} />
                  <Links label={t("dag.children")} ids={graph!.nodes.filter((item) => item.parentId === node.id).map((item) => item.id)} graph={graph!} select={show} palette={palette} />
                  <Section title={t("dag.instruction")} text={node.instruction} palette={palette} />
                  {node.acceptance ? <Section title={t("dag.acceptance")} text={node.acceptance} palette={palette} /> : null}
                  {node.report ? <Section title={t("dag.conclusion")} text={node.report.summary} palette={palette} /> : null}
                  {node.report?.evidence?.length ? <Section title={t("dag.evidence")} text={node.report.evidence.join("\n\n")} palette={palette} /> : null}
                  {node.report?.artifacts?.length ? <Section title={t("dag.artifacts")} text={node.report.artifacts.join("\n")} palette={palette} /> : null}
                  {node.model ? <Section title={t("dag.model")} text={node.model} palette={palette} /> : null}
                  {remote ? <TaskOutput key={`${node.id}:${node.runId}:${node.status}`} client={remote} conversationId={conversationId} node={node} palette={palette} /> : node.output ? <Section title={t("dag.output")} text={node.output} palette={palette} /> : null}
                </ScrollView>
              )}
            </View>
          ) : loading ? <View style={styles.empty}><DesktopSpinner color={palette.accent} /><Text style={{ color: palette.muted }}>{t("dag.loading")}</Text></View> : !graph || !graph.nodes.length ? (
            <View style={styles.empty}><Text style={{ color: palette.muted }}>{t(error ? "dag.unavailable" : "dag.empty")}</Text><Action label={t("dag.refresh")} palette={palette} disabled={!remote} onPress={() => { setLoading(true); void watcher.current?.refresh(); }} /></View>
          ) : (
            <FlatList data={rows} keyExtractor={({ node: item }) => item.id} contentContainerStyle={styles.list} initialNumToRender={12}
              ListHeaderComponent={<View style={styles.actions}>
                {progress.attention ? <Text style={{ color: palette.warning }}>{t("dag.attention", { count: progress.attention })}</Text> : null}
                {progress.active ? <Action label={t("dag.cancelAll")} palette={palette} disabled={disabled} onPress={() => void action("dag:cancel")} /> : null}
                {state === "stopped" ? <Action label={t("dag.resume")} palette={palette} disabled={disabled} onPress={() => void action("dag:resume")} /> : null}
              </View>}
              renderItem={({ item: { node: item, depth, previousAttempt } }) => (
                <Pressable accessibilityRole="button" accessibilityLabel={`${item.id} ${item.title} ${t(`dag.status.${item.status}`)}`} onPress={() => show(item.id)}
                  style={({ pressed }) => [styles.task, { paddingLeft: 12 + Math.min(depth, 3) * 14, borderColor: palette.separator, backgroundColor: pressed ? palette.field : palette.card }]}>
                  <View style={styles.taskBody}><View style={styles.actions}><Text style={[styles.id, { color: palette.muted }]}>{item.id}</Text><Status node={item} palette={palette} /></View>
                    <Text style={[styles.title, { color: palette.text }]} numberOfLines={2}>{item.title}</Text>
                    <Text style={[styles.caption, { color: palette.muted }]} numberOfLines={1}>{previousAttempt ? t("dag.previousAttempt") : item.coordinator ? t("dag.coordinator") : item.profile.name}</Text>
                  </View><HugeiconsIcon icon={ArrowRight01Icon} size={16} color={palette.subtle} />
                </Pressable>
              )} />
          )}
        </Sheet>
      </SummaryContext.Provider>
    </DagContext.Provider>
  );
}

export function MobileDagSummary() {
  useT(); const palette = usePalette(); const context = useContext(SummaryContext);
  if (!context?.graph?.nodes.length) return null;
  const progress = dagProgress(context.graph.nodes);
  return <Pressable accessibilityRole="button" accessibilityLabel={t("dag.open")} onPress={context.open} style={[styles.summary, { backgroundColor: palette.card, borderColor: palette.border }]}>
    {progress.active ? <DesktopSpinner size={15} color={palette.accent} /> : <HugeiconsIcon icon={BotIcon} size={17} color={palette.muted} />}
    <Text style={[styles.summaryText, { color: palette.text }]}>{t("dag.title")} · {t("dag.progress", { done: progress.completed, total: progress.total })}</Text>
    {!context.connected ? <Text style={[styles.caption, { color: palette.muted }]}>{t("dag.offline")}</Text> : progress.attention ? <Text style={[styles.caption, { color: palette.warning }]}>{t("dag.attention", { count: progress.attention })}</Text> : null}
    <HugeiconsIcon icon={ArrowRight01Icon} size={15} color={palette.subtle} />
  </Pressable>;
}

function Action({ label, onPress, palette, disabled, active }: { label: string; onPress: () => void; palette: Palette; disabled?: boolean; active?: boolean }) {
  return <Pressable accessibilityRole="button" accessibilityState={{ disabled, selected: active }} disabled={disabled} onPress={onPress} style={({ pressed }) => [styles.action, { backgroundColor: active ? palette.accentSoft : palette.field, opacity: disabled ? 0.4 : pressed ? 0.6 : 1 }]}><Text style={{ color: active ? palette.accent : palette.text, fontSize: 13, fontWeight: "600" }}>{label}</Text></Pressable>;
}
function Status({ node, palette }: { node: DagNode; palette: Palette }) {
  const color = node.status === "failed" ? palette.danger : node.status === "blocked" ? palette.warning : node.status === "completed" ? palette.success : node.status === "running" ? palette.accent : palette.muted;
  return <Text style={[styles.caption, { color }]}>{t(`dag.status.${node.status}`)}</Text>;
}
function Section({ title, text, palette }: { title: string; text: string; palette: Palette }) {
  return <View style={styles.section}><Text style={[styles.caption, { color: palette.muted }]}>{title}</Text><Text selectable style={[styles.prose, { color: palette.text }]}>{text}</Text></View>;
}
function Links({ label, ids, graph, select, palette }: { label: string; ids: string[]; graph: DagGraph; select: (id: string) => void; palette: Palette }) {
  if (!ids.length) return null;
  return <View style={styles.section}><Text style={[styles.caption, { color: palette.muted }]}>{label}</Text>{ids.map((id) => {
    const node = graph.nodes.find((item) => item.id === id);
    return <Pressable key={id} accessibilityRole="button" disabled={!node} onPress={() => select(id)} style={styles.link}><Text style={{ color: palette.accent }}>{id} · {node?.title ?? ""}</Text></Pressable>;
  })}</View>;
}
function TaskOutput({ client, node, conversationId, palette }: { client: Client; node: DagNode; conversationId: string; palette: Palette }) {
  const [text, setText] = useState<string | null>(null);
  const [offset, setOffset] = useState<number | undefined>();
  const [busy, setBusy] = useState(false);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  async function more() {
    if (busy) return; setBusy(true);
    try {
      const page = await client.call("dag:output", { conversationId, id: node.id, offset: text === null ? 0 : offset }) as DagOutputPage;
      if (!alive.current) return;
      setText((previous) => (previous ?? "") + page.output); setOffset(page.nextOffset);
    } catch (error) { if (alive.current) toast.error(error instanceof Error ? error.message : t("dag.loadFailed")); }
    finally { if (alive.current) setBusy(false); }
  }
  if (!node.output && text === null) return null;
  return <View style={styles.section}><Text style={[styles.caption, { color: palette.muted }]}>{t("dag.output")}</Text><MarkdownView text={text ?? node.output ?? ""} palette={palette} />
    {dagNodeFinished(node.status) && (text === null ? (node.outputLength ?? 0) > DAG_PREVIEW_CHARS : offset !== undefined) ? <Action label={t(busy ? "dag.loading" : text === null ? "dag.readFull" : "dag.readMore")} palette={palette} disabled={busy} onPress={() => void more()} /> : null}
  </View>;
}

/** Read checkpoints on step boundaries, not a large transcript RPC for every token. */
function RunTranscript({ client, node, conversationId, palette }: { client: Client; node: DagNode; conversationId: string; palette: Palette }) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [limit, setLimit] = useState(40);
  const reload = useRef<() => void>(() => {});
  useEffect(() => {
    let disposed = false; let pending = false; let again = false; let timer: ReturnType<typeof setTimeout> | undefined;
    async function read() {
      if (disposed) return;
      if (pending) { again = true; return; }
      pending = true;
      try {
        const value = await client.call("engine:get-subagent-messages", { conversationId, subagentId: node.runId });
        if (!disposed) { setMessages(Array.isArray(value) ? value : []); setError(false); }
      } catch { if (!disposed) setError(true); }
      finally {
        pending = false;
        if (!disposed) { setLoading(false); if (again) { again = false; void read(); } }
      }
    }
    reload.current = () => void read();
    const off = onEngineEvent((event) => {
      if (event.conversationId !== conversationId || event.subagentId !== node.runId) return;
      const inner = event.event as { type?: string } | undefined;
      if (event.type === "subagent_lifecycle" || (event.type === "subagent_event" && ["turn_end", "agent_settled"].includes(inner?.type ?? ""))) {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => void read(), 150);
      }
    });
    void read();
    return () => { disposed = true; if (timer) clearTimeout(timer); off(); };
  }, [client, conversationId, node.runId]);
  useEffect(() => { if (dagNodeFinished(node.status)) reload.current(); }, [node.status]);
  return <FlatList data={messages.slice(-limit)} keyExtractor={(message, index) => message.id || String(index)} contentContainerStyle={styles.detail} initialNumToRender={8}
    ListHeaderComponent={<View style={styles.section}>
      {!dagNodeFinished(node.status) ? <Text style={{ color: palette.muted }}>{t("dag.executionLive")}</Text> : null}
      {messages.length > limit ? <Action label={t("dag.earlier")} palette={palette} onPress={() => setLimit((value) => value + 40)} /> : null}
      {error ? <Action label={t("dag.refresh")} palette={palette} onPress={() => reload.current()} /> : null}
    </View>}
    ListEmptyComponent={<Text style={{ color: palette.muted }}>{t(loading ? "dag.loading" : error ? "dag.loadFailed" : "dag.noExecution")}</Text>}
    renderItem={({ item }) => <RunMessage message={item} palette={palette} />} />;
}
function RunMessage({ message, palette }: { message: ChatMessage; palette: Palette }) {
  const blocks: Array<{ kind: "text"; text: string } | { kind: "process"; items: ProcessItem[] }> = [];
  const parts = message.parts?.length ? message.parts : [
    ...(message.thinking ? [{ kind: "thinking" as const, text: message.thinking }] : []),
    ...(message.text ? [{ kind: "text" as const, text: message.text }] : []),
    ...(message.tools ?? []).map((tool) => ({ kind: "tool" as const, toolId: tool.id })),
  ];
  for (const part of parts) {
    if (part.kind === "text") blocks.push({ kind: "text", text: part.text });
    else {
      const tool = part.kind === "tool" ? message.tools?.find((item) => item.id === part.toolId) : undefined;
      const item: ProcessItem | undefined = part.kind === "thinking" ? { kind: "thinking", text: part.text } : tool ? { kind: "tool", tool } : undefined;
      if (!item) continue;
      const last = blocks.at(-1);
      if (last?.kind === "process") last.items.push(item); else blocks.push({ kind: "process", items: [item] });
    }
  }
  return <View style={styles.section}>{message.role === "user" ? <Text style={{ color: palette.muted }}>{t("dag.instruction")}</Text> : null}
    {blocks.map((block, i) => block.kind === "text" ? <MarkdownView key={i} text={block.text} palette={palette} /> : <ProcessGroup key={i} items={block.items} palette={palette} />)}
    {message.error ? <Text style={{ color: palette.danger }}>{message.error}</Text> : null}</View>;
}

const styles = StyleSheet.create({
  flex: { flex: 1, minHeight: 0 },
  summary: { flexDirection: "row", alignItems: "center", gap: 8, minHeight: 44, paddingHorizontal: 16, paddingVertical: 8, borderBottomWidth: StyleSheet.hairlineWidth },
  summaryText: { flex: 1, fontSize: 13, fontWeight: "600" },
  tabs: { flexDirection: "row", gap: 8, paddingHorizontal: 16, paddingBottom: 10, borderBottomWidth: StyleSheet.hairlineWidth },
  list: { paddingHorizontal: 12, paddingBottom: 24 },
  detail: { padding: 16, gap: 16 },
  empty: { flex: 1, alignItems: "center", justifyContent: "center", gap: 14, padding: 24 },
  actions: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8 },
  action: { paddingHorizontal: 12, minHeight: 40, alignItems: "center", justifyContent: "center", borderRadius: 10 },
  task: { flexDirection: "row", alignItems: "center", paddingVertical: 12, paddingRight: 10, gap: 10, borderBottomWidth: StyleSheet.hairlineWidth },
  taskBody: { flex: 1, gap: 5 },
  title: { fontSize: 14, fontWeight: "600", lineHeight: 20 },
  id: { fontFamily: "monospace", fontSize: 11 },
  caption: { fontSize: 12, lineHeight: 17 },
  prose: { fontSize: 14, lineHeight: 21 },
  section: { gap: 8 },
  error: { padding: 12, borderRadius: 10, lineHeight: 20 },
  link: { minHeight: 40, justifyContent: "center" },
});
