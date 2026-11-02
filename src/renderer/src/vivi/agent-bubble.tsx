import { useCallback, useEffect, useLayoutEffect, useRef, useState, type JSX } from "react";
import { createRoot } from "react-dom/client";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { TooltipProvider } from "@/components/ui/tooltip";
import { PermissionPanel, type PermissionResponse } from "@/components/chat/permission-panel";
import { applyUiLanguage } from "@/lib/i18n";
import { applyThemePreferences } from "@/lib/themes";
import { ViviAgentActivity, viviClickFeedback } from "@/lib/vivi-agent-activity";
import { sendViviMessage, viviLatestReply } from "@/lib/vivi-chat";
import { ArrowUp02Icon } from "@hugeicons/core-free-icons";
import { engine, respondPermission } from "@/lib/engine-client";
import { HugeiconsIcon } from "@hugeicons/react";
import { Add01Icon, Cancel01Icon, ArrowDown01Icon, ArrowUpRight01Icon } from "@hugeicons/core-free-icons";
import { Input } from "@/components/ui/input";
import { ViviChatter } from "@/lib/vivi-chatter";
import type { ViviDragMotion, ViviSnapshot } from "@shared/vivi";
import type { PermissionRequest } from "@shared/types";
import "../index.css";

const activity = new ViviAgentActivity();
const api = window.fastvibe;

type SurfaceState = { snapshot?: ViviSnapshot; feedback?: string; moving: boolean };
let surface: SurfaceState = { moving: false };
const listeners = new Set<() => void>();
let feedbackTimer: ReturnType<typeof setTimeout> | undefined;
let clickIndex = 0;
const chatter = new ViviChatter();
let interactionBusy = false;

function displayFeedback(feedback: string): void {
  if (feedbackTimer) clearTimeout(feedbackTimer);
  surface = { ...surface, feedback };
  for (const listener of listeners) listener();
  feedbackTimer = setTimeout(() => {
    feedbackTimer = undefined;
    surface = { ...surface, feedback: undefined };
    for (const listener of listeners) listener();
  }, 3200);
}

function maybeSpeak(): void {
  const snapshot = surface.snapshot;
  const blocked = !snapshot?.visible || !snapshot.settings.enabled || interactionBusy || Boolean(surface.feedback)
    || snapshot.actors.some((actor) => actor.mood !== "idle")
    || activity.requests.length > 0 || activity.agents.some((agent) => agent.mood !== "idle");
  const line = chatter.next(snapshot?.uiLanguage ?? "zh", blocked);
  if (line) displayFeedback(line);
}

export function noteViviMotion(motion: ViviDragMotion): void {
  chatter.motion(motion);
  maybeSpeak();
}

export function noteViviHover(inside: boolean): void { chatter.hover(inside); }

export function updateViviBubble(snapshot: ViviSnapshot): void {
  surface = { ...surface, snapshot };
  applyUiLanguage(snapshot.uiLanguage ?? "zh");
  for (const listener of listeners) listener();
}

export function setViviBubbleMoving(moving: boolean): void {
  if (surface.moving === moving) return;
  surface = { ...surface, moving };
  for (const listener of listeners) listener();
}

export function showViviClickFeedback(): void {
  chatter.interacted();
  displayFeedback(viviClickFeedback(surface.snapshot?.uiLanguage ?? "zh", clickIndex++));
}

function EditorPrompt({ request, respond }: { request: PermissionRequest; respond: (response: PermissionResponse) => void }): JSX.Element {
  const { t } = useTranslation("chat");
  const [draft, setDraft] = useState(request.prefill ?? "");
  return <div className="space-y-3 p-3">
    <p className="text-sm font-medium">{request.title}</p>
    {request.message ? <p className="whitespace-pre-wrap text-sm text-muted-foreground">{request.message}</p> : null}
    <Textarea value={draft} onChange={(event) => setDraft(event.target.value)} className="min-h-32 max-h-56" />
    <div className="flex justify-end gap-2">
      <Button size="sm" variant="outline" onClick={() => respond({ id: request.id, cancelled: true })}>{t("permission.cancel")}</Button>
      <Button size="sm" onClick={() => respond({ id: request.id, value: draft })}>{t("permission.submit")}</Button>
    </div>
  </div>;
}

function ViviBubble(): JSX.Element | null {
  const { t } = useTranslation("chat");
  const [, redraw] = useState(0);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [collapsed, setCollapsed] = useState(true);
  const [compose, setCompose] = useState(false);
  const [newChat, setNewChat] = useState(false);
  const [conversationId, setConversationId] = useState<string>();
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [sending, setSending] = useState(false);
  const sendInFlight = useRef(false);
  const [dismissed, setDismissed] = useState<string>();
  const composing = useRef(false);
  const replyLoading = useRef(new Set<string>());
  const element = useRef<HTMLDivElement>(null);
  const measurement = useRef<HTMLSpanElement>(null);
  const [textSize, setTextSize] = useState<{ width: number; height: number }>();
  const lastLayout = useRef<ViviSnapshot["surface"]>(undefined);
  const refreshInFlight = useRef(false);
  const refreshAgain = useRef(false);
  const alive = useRef(true);
  const change = useCallback(() => redraw((value) => value + 1), []);
  const loadReply = useCallback(async (id: string) => {
    if (replyLoading.current.has(id)) return;
    replyLoading.current.add(id);
    const revision = activity.agents.find((agent) => agent.id === id)?.replyRevision ?? 0;
    try {
      const { messages } = await engine.getSnapshot(id, 2);
      if (!alive.current) return;
      const reply = viviLatestReply(messages);
      if (activity.setReply(id, reply, revision)) change();
    } catch { /* The compact bubble keeps live status when a transcript is unavailable. */ }
    finally { replyLoading.current.delete(id); }
  }, [change]);
  const refresh = useCallback(async () => {
    if (refreshInFlight.current) { refreshAgain.current = true; return; }
    refreshInFlight.current = true;
    try {
      do {
        refreshAgain.current = false;
        const revision = activity.revision;
        const [pending, running, workspace] = await Promise.all([api.engine.getPendingUi(), api.engine.getRunning(), api.conversations.list()]);
        if (!alive.current) return;
        activity.setCatalog(workspace.conversations);
        if (!activity.restore(pending, running, revision)) refreshAgain.current = true;
        setError("");
        change();
      } while (refreshAgain.current && alive.current);
    } catch { if (alive.current) setError(t("vivi.connectionFailed")); }
    finally { refreshInFlight.current = false; }
  }, [change, t]);

  useEffect(() => {
    alive.current = true;
    listeners.add(change);
    const off = api.engine.onEvent((event) => {
      if (activity.event(event)) change();
      if (event.type === "conversation_activity" && typeof event.conversationId === "string") void loadReply(event.conversationId);
      if (event.type === "extension_ui_request" || event.type === "extension_ui_dismiss" || event.type === "conversation_running") void refresh();
    });
    const catalog = api.conversations.onChanged(() => void refresh());
    const timer = setInterval(() => { void refresh(); }, 2000);
    const theme = api.settings.onChanged((settings) => applyThemePreferences(settings as Parameters<typeof applyThemePreferences>[0]));
    void refresh();
    return () => { alive.current = false; listeners.delete(change); off(); catalog(); theme(); clearInterval(timer); };
  }, [change, refresh, loadReply]);

  const snapshot = surface.snapshot;
  const requests = activity.requests;
  const request = requests[0];
  const requestId = request?.id;
  useEffect(() => { setCollapsed(true); setError(""); setDismissed(undefined); }, [requestId]);
  const agents = activity.agents;
  const active = agents.filter((agent) => agent.mood !== "idle");
  const selected = agents.find((agent) => agent.id === request?.conversationId)
    ?? (conversationId ? agents.find((agent) => agent.id === conversationId) : undefined)
    ?? active[0] ?? agents.find((agent) => agent.id === snapshot?.actors[0]?.conversationId);
  const selectedId = request?.conversationId ?? (newChat ? undefined : conversationId ?? selected?.id);
  const mood = request ? "waiting" : selected?.mood ?? snapshot?.actors[0]?.mood ?? "idle";
  const content = error || surface.feedback || request?.message || request?.questions?.[0]?.question
    || (request ? t("vivi.moods.waiting") : mood === "thinking" ? t("vivi.moods.thinking") : selected?.tool ? t("vivi.tool", { tool: selected.tool }) : selected?.reply || t(`vivi.moods.${mood}`));
  const identity = `${request?.id ?? ""}:${selected?.id ?? ""}:${mood}:${selected?.replyRevision ?? 0}:${surface.feedback ?? ""}`;
  const show = Boolean(surface.feedback || request || selected?.reply || mood !== "idle") && dismissed !== identity;
  const expanded = Boolean(request && !collapsed && show);
  useEffect(() => {
    interactionBusy = compose || expanded || busy || sending;
    return () => { interactionBusy = false; };
  }, [compose, expanded, busy, sending]);
  useLayoutEffect(() => {
    const node = measurement.current;
    if (!node || !show || expanded || compose) return;
    const measure = (): void => {
      const rect = node.getBoundingClientRect();
      const next = { width: Math.ceil(rect.width), height: Math.ceil(rect.height) };
      if (next.width <= 0 || next.height <= 0) return;
      setTextSize((previous) => previous?.width === next.width && previous?.height === next.height ? previous : next);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    void document.fonts.ready.then(measure);
    return () => observer.disconnect();
  }, [content, show, expanded, compose]);
  const height = expanded ? 460 : show ? compose ? 120 : textSize?.height ?? 0 : 0;
  const controlsHeight = compose ? 60 : 0;
  const width = expanded || compose ? 360 : textSize?.width;
  useEffect(() => { void api.vivi.setBubble(height, controlsHeight, width).catch(() => undefined); }, [height, controlsHeight, width]);
  useEffect(() => {
    if (!selectedId) return;
    void loadReply(selectedId);
    const timer = setInterval(() => { void loadReply(selectedId); }, 2500);
    return () => clearInterval(timer);
  }, [selectedId, loadReply]);
  if (snapshot?.surface) lastLayout.current = snapshot.surface;
  const layout = snapshot?.surface ?? (surface.moving ? lastLayout.current : undefined);
  const draftKey = selectedId ?? "new";
  const draft = drafts[draftKey] ?? "";

  const respond = async (response: PermissionResponse): Promise<void> => {
    if (busy || !activity.requests.some((item) => item.id === response.id)) return;
    setBusy(true);
    setError("");
    try {
      const fresh = await api.engine.getPendingUi();
      if (!fresh.some((item) => item.id === response.id)) { await refresh(); return; }
      await respondPermission(response);
      activity.remove(response.id);
      if (feedbackTimer) clearTimeout(feedbackTimer);
      surface = { ...surface, feedback: t("vivi.answerReceived") };
      feedbackTimer = setTimeout(() => {
        surface = { ...surface, feedback: undefined };
        for (const listener of listeners) listener();
      }, 2400);
      change();
      await refresh();
    } catch { setError(t("vivi.responseFailed")); }
    finally { if (alive.current) setBusy(false); }
  };

  const send = async (): Promise<void> => {
    const originalDraft = draft;
    const text = originalDraft.trim();
    if (!text || sendInFlight.current || composing.current) return;
    sendInFlight.current = true;
    setSending(true);
    setError("");
    try {
      const id = await sendViviMessage({
        create: async () => {
          const created = await api.conversations.create(undefined, { activate: false, reuseEmpty: false });
          activity.setCatalog(created.conversations);
          return created.conversation.id;
        },
        created: (id) => {
          setConversationId(id);
          setNewChat(false);
          setDrafts((current) => ({ ...current, [id]: originalDraft }));
        },
        isRunning: (id) => activity.agents.some((agent) => agent.id === id && (agent.mood === "working" || agent.mood === "thinking")),
        submit: (payload) => engine.submitPrompt(payload),
      }, text, selectedId);
      setDrafts((current) => ({ ...current, [id]: current[id] === originalDraft ? "" : current[id], ...(draftKey === "new" && current.new === originalDraft ? { new: "" } : {}) }));
      setCompose(true);
      setDismissed(undefined);
      change();
      void loadReply(id);
      void refresh();
    } catch { setError(t("vivi.sendFailed")); }
    finally { sendInFlight.current = false; if (alive.current) setSending(false); }
  };

  const bubble = layout?.bubble;
  const controls = layout?.composer;
  const boundsStyle = (bounds: { x: number; y: number; width: number; height: number }) => ({ position: "absolute" as const, visibility: surface.moving ? "hidden" as const : "visible" as const, left: bounds.x, top: bounds.y, width: bounds.width, height: bounds.height });
  const openComposer = (): void => { setCompose(true); if (!conversationId && selected) setConversationId(selected.id); };
  return <>
    <span ref={measurement} className="vivi-bubble-measure vivi-bubble-text" aria-hidden="true">{content}</span>
    {show && bubble && bubble.height > 0 ? <div ref={element}
      className={`vivi-agent-bubble vivi-text-bubble pointer-events-auto flex flex-col ${expanded ? "is-expanded" : ""}`}
      style={boundsStyle(bubble)} onPointerEnter={() => void api.vivi.hitTest(true)}>
      <div className={`flex shrink-0 items-center gap-2 ${expanded || compose ? "px-4 py-2" : ""}`}>
        <Button variant="ghost" className={`h-auto min-w-0 flex-1 justify-start rounded-none text-left hover:bg-transparent ${expanded || compose ? "p-0" : "vivi-bubble-text"}`}
          onClick={() => request ? setCollapsed(!collapsed) : openComposer()}>
          <span className="block w-full whitespace-pre-wrap break-words text-sm font-normal leading-5">{content}</span>
        </Button>
        {compose || expanded ? <Button variant="secondary" size="icon-sm" className="size-9 shrink-0 rounded-full" title={request ? t("vivi.collapse") : t("vivi.openConversation")}
          onClick={() => request ? setCollapsed(!collapsed) : selected && void api.vivi.openConversation(selected.id)}>
          <HugeiconsIcon icon={request ? ArrowDown01Icon : ArrowUpRight01Icon} className="size-4" />
        </Button> : null}
      </div>
      {compose && !request && selected?.reply ? <p className="min-h-0 flex-1 overflow-y-auto whitespace-pre-wrap break-words px-5 pb-4 text-sm leading-5">{selected.reply}</p> : null}
      {expanded && request ? <div className={`min-h-0 flex-1 overflow-y-auto pb-2 ${busy ? "pointer-events-none opacity-60" : ""}`} aria-busy={busy}>
        {request.method === "editor" ? <EditorPrompt key={request.id} request={request} respond={(answer) => void respond(answer)} />
          : <PermissionPanel key={request.id} request={request} onRespond={(answer) => void respond(answer)} />}
      </div> : null}
      <Button variant="secondary" size="icon-xs" className="vivi-bubble-close absolute -left-2.5 -top-2.5 size-6 rounded-full border border-border" aria-label={t("vivi.dismiss")}
        onClick={() => { setDismissed(identity); setCollapsed(true); }}><HugeiconsIcon icon={Cancel01Icon} className="size-3.5" /></Button>
    </div> : null}
    {compose && controls && controls.height >= 30 ? <div className="vivi-agent-bubble vivi-composer pointer-events-auto" style={boundsStyle(controls)} onPointerEnter={() => void api.vivi.hitTest(true)}>
      <form className="flex h-full items-center gap-2 px-3" onSubmit={(event) => { event.preventDefault(); void send(); }}>
        <Button type="button" variant="ghost" size="icon-sm" className="rounded-full" aria-label={t("vivi.newChat")} disabled={sending}
          onClick={() => { setNewChat(true); setConversationId(undefined); setError(""); }}><HugeiconsIcon icon={Add01Icon} className="size-5" /></Button>
        <Input value={draft} onChange={(event) => setDrafts((current) => ({ ...current, [draftKey]: event.target.value }))}
          onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }}
          onKeyDown={(event) => { if (event.key === "Enter" && (event.nativeEvent.isComposing || composing.current)) event.preventDefault(); if (event.key === "Escape") setCompose(false); }}
          autoFocus placeholder={t(selectedId ? "vivi.followUp" : "vivi.newChat")} aria-label={t(selectedId ? "vivi.followUp" : "vivi.newChat")}
          className="min-w-0 flex-1 rounded-none border-0 bg-transparent px-0 shadow-none focus-visible:ring-0" />
        <Button type="submit" size="icon-sm" className="size-9 rounded-full" aria-label={t("vivi.send")} disabled={!draft.trim() || sending}>
          <HugeiconsIcon icon={ArrowUp02Icon} className="size-4" />
        </Button>
      </form>
    </div> : null}
  </>;
}

export function mountViviBubble(): () => void {
  applyThemePreferences(api.settings.initial as Parameters<typeof applyThemePreferences>[0]);
  const element = document.getElementById("vivi-bubble-root");
  if (!element) throw new Error("Vivi bubble root is missing");
  const root = createRoot(element);
  root.render(<TooltipProvider><ViviBubble /></TooltipProvider>);
  const chatterTimer = setInterval(maybeSpeak, 750);
  return () => { clearInterval(chatterTimer); if (feedbackTimer) clearTimeout(feedbackTimer); root.unmount(); };
}
