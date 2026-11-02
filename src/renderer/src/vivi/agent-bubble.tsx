import { useCallback, useEffect, useLayoutEffect, useRef, useState, type JSX } from "react";
import { createRoot } from "react-dom/client";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { TooltipProvider } from "@/components/ui/tooltip";
import { applyUiLanguage } from "@/lib/i18n";
import { applyThemePreferences } from "@/lib/themes";
import { ViviAgentActivity, viviClickFeedback } from "@/lib/vivi-agent-activity";
import { viviLatestReply } from "@/lib/vivi-chat";
import { ViviNotificationLifetime } from "@/lib/vivi-notification";
import { engine } from "@/lib/engine-client";
import { HugeiconsIcon } from "@hugeicons/react";
import { Cancel01Icon } from "@hugeicons/core-free-icons";
import { ViviChatter } from "@/lib/vivi-chatter";
import type { ViviDragMotion, ViviSnapshot } from "@shared/vivi";
import "../index.css";

const activity = new ViviAgentActivity();
const api = window.fastvibe;

type SurfaceState = { snapshot?: ViviSnapshot; feedback?: string; feedbackId: number; moving: boolean };
let surface: SurfaceState = { moving: false, feedbackId: 0 };
const listeners = new Set<() => void>();
let clickIndex = 0;
const chatter = new ViviChatter();
let interactionBusy = false;

function displayFeedback(feedback: string): void {
  surface = { ...surface, feedback, feedbackId: surface.feedbackId + 1 };
  for (const listener of listeners) listener();
}

function maybeSpeak(): void {
  const snapshot = surface.snapshot;
  const blocked = !snapshot?.visible || !snapshot.settings.enabled || snapshot.settings.messages === false || snapshot.appFocused === true || interactionBusy || Boolean(surface.feedback)
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
  if (surface.snapshot?.settings.messages === false) return;
  chatter.interacted();
  displayFeedback(viviClickFeedback(surface.snapshot?.uiLanguage ?? "zh", clickIndex++));
}

function ViviBubble(): JSX.Element | null {
  const { t } = useTranslation("chat");
  const [, redraw] = useState(0);
  const [error, setError] = useState("");
  const [hovered, setHovered] = useState(false);
  const [visible, setVisible] = useState(false);
  const lifetime = useRef(new ViviNotificationLifetime());
  const replyLoading = useRef(new Set<string>());
  const measurement = useRef<HTMLSpanElement>(null);
  const [textSize, setTextSize] = useState<{ width: number; height: number }>();
  const lastLayout = useRef<ViviSnapshot["surface"]>(undefined);
  const refreshInFlight = useRef(false);
  const refreshAgain = useRef(false);
  const alive = useRef(true);
  const change = useCallback(() => redraw((value) => value + 1), []);
  const loadReply = useCallback(async (id: string) => {
    if (surface.snapshot?.settings.messages === false || replyLoading.current.has(id)) return;
    replyLoading.current.add(id);
    const revision = activity.agents.find((agent) => agent.id === id)?.replyRevision ?? 0;
    try {
      const { messages } = await engine.getSnapshot(id, 2);
      if (!alive.current) return;
      const reply = viviLatestReply(messages);
      if (activity.setReply(id, reply, revision)) change();
    } catch { /* Keep the live status when a transcript is unavailable. */ }
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
  const request = activity.requests[0];
  const agents = activity.agents;
  const selected = agents.find((agent) => agent.id === request?.conversationId)
    ?? agents.find((agent) => agent.id === snapshot?.actors[0]?.conversationId)
    ?? agents.find((agent) => agent.mood !== "idle");
  const selectedId = request?.conversationId ?? selected?.id;
  const mood = request ? "waiting" : selected?.mood ?? snapshot?.actors[0]?.mood ?? "idle";
  const content = error || surface.feedback || request?.message || request?.questions?.[0]?.question
    || (request ? t("vivi.moods.waiting") : mood === "thinking" ? t("vivi.moods.thinking") : selected?.tool ? t("vivi.tool", { tool: selected.tool }) : selected?.reply || t(`vivi.moods.${mood}`));
  const source = error ? "error" : surface.feedback ? "feedback" : request ? `request:${request.id}` : `agent:${selectedId ?? "vivi"}`;
  // A mood returning to idle must not replay the reply that already timed out.
  const identity = `${surface.feedback ? surface.feedbackId : request?.id ?? selected?.replyRevision ?? ""}:${content}`;
  const suppressed = !snapshot?.visible || !snapshot.settings.enabled || snapshot.settings.messages === false || snapshot.appFocused === true
    || !Boolean(error || surface.feedback || request || selected?.reply || mood !== "idle");
  const show = visible && !suppressed;

  useEffect(() => {
    const notice = lifetime.current;
    notice.update(source, identity, suppressed);
    notice.hover(hovered);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const sync = (): void => {
      const showing = notice.visible;
      setVisible(showing);
      if (showing && !hovered) timer = setTimeout(sync, notice.remaining);
      if (!showing) {
        setHovered(false);
        if (source === "feedback") {
          surface = { ...surface, feedback: undefined };
          change();
        }
      }
    };
    sync();
    return () => clearTimeout(timer);
  }, [source, identity, suppressed, hovered, change]);

  useEffect(() => {
    interactionBusy = show && hovered;
    return () => { interactionBusy = false; };
  }, [show, hovered]);

  useLayoutEffect(() => {
    const node = measurement.current;
    if (!node || !show) return;
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
  }, [content, show]);
  const height = show ? textSize?.height ?? 0 : 0;
  const width = textSize?.width;
  useEffect(() => { void api.vivi.setBubble(height, 0, width).catch(() => undefined); }, [height, width]);
  useEffect(() => {
    if (!selectedId) return;
    void loadReply(selectedId);
    const timer = setInterval(() => { void loadReply(selectedId); }, 2500);
    return () => clearInterval(timer);
  }, [selectedId, loadReply]);
  if (snapshot?.surface) lastLayout.current = snapshot.surface;
  const layout = snapshot?.surface ?? (surface.moving ? lastLayout.current : undefined);
  const bubble = layout?.bubble;
  return <>
    <span ref={measurement} className="vivi-bubble-measure vivi-bubble-text" aria-hidden="true">{content}</span>
    {show && bubble && bubble.height > 0 ? <div
      className="vivi-agent-bubble vivi-text-bubble pointer-events-auto"
      style={{ position: "absolute", visibility: surface.moving ? "hidden" : "visible", left: bubble.x, top: bubble.y, width: bubble.width, height: bubble.height }}
      onPointerEnter={() => { setHovered(true); void api.vivi.hitTest(true); }}
      onPointerLeave={() => setHovered(false)}>
      <Button variant="ghost" className="vivi-bubble-text h-full w-full min-w-0 justify-start rounded-[inherit] text-left hover:bg-transparent"
        title={t("vivi.openConversation")} onClick={() => void api.vivi.openConversation(selectedId)}>
        <span className="vivi-notification-content block w-full text-sm font-normal leading-5">{content}</span>
      </Button>
      <Button variant="secondary" size="icon-xs" className="vivi-bubble-close absolute -left-2.5 -top-2.5 size-6 rounded-full border border-border" aria-label={t("vivi.dismiss")}
        onClick={() => {
          lifetime.current.dismiss();
          setVisible(false);
          setHovered(false);
          if (source === "feedback") { surface = { ...surface, feedback: undefined }; change(); }
        }}><HugeiconsIcon icon={Cancel01Icon} className="size-3.5" /></Button>
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
  return () => { clearInterval(chatterTimer); root.unmount(); };
}
