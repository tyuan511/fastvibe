import { useCallback, useEffect, useLayoutEffect, useRef, useState, type JSX } from "react";
import { createRoot } from "react-dom/client";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { TooltipProvider } from "@/components/ui/tooltip";
import { applyUiLanguage } from "@/lib/i18n";
import { applyThemePreferences } from "@/lib/themes";
import { ViviCompletionState } from "@/lib/vivi-completion";
import { ViviNotificationLifetime } from "@/lib/vivi-notification";
import { engine } from "@/lib/engine-client";
import { HugeiconsIcon } from "@hugeicons/react";
import { Cancel01Icon } from "@hugeicons/core-free-icons";
import type { ViviSnapshot } from "@shared/vivi";
import "../index.css";

const api = window.fastvibe;
let surface: { snapshot?: ViviSnapshot; moving: boolean } = { moving: false };
const listeners = new Set<() => void>();
const lifetime = new ViviNotificationLifetime();

function notify(): void { for (const listener of listeners) listener(); }

export function updateViviBubble(snapshot: ViviSnapshot): void {
  surface = { ...surface, snapshot };
  applyUiLanguage(snapshot.uiLanguage ?? "zh");
  notify();
}

export function setViviBubbleMoving(moving: boolean): void {
  if (surface.moving === moving) return;
  surface = { ...surface, moving };
  lifetime.setMoving(moving);
  notify();
}

function ViviBubble(): JSX.Element | null {
  const { t } = useTranslation("chat");
  const [, redraw] = useState(0);
  const [hovered, setHovered] = useState(false);
  const [visible, setVisible] = useState(false);
  const completions = useRef(new ViviCompletionState());
  const measurement = useRef<HTMLSpanElement>(null);
  const [textSize, setTextSize] = useState<{ width: number; height: number }>();
  const change = useCallback(() => redraw((value) => value + 1), []);

  useEffect(() => {
    let alive = true;
    listeners.add(change);
    const off = api.engine.onEvent((event) => {
      const previous = completions.current.completion;
      const request = completions.current.event(event);
      if (previous !== completions.current.completion) change();
      if (!request) return;
      const snapshot = surface.snapshot;
      // Foreground/disabled completions are consumed where they arrive, even if
      // focus changes while the transcript read would have been in flight.
      if (!snapshot?.visible || !snapshot.settings.enabled || snapshot.settings.messages === false || snapshot.appFocused === true) return;
      void engine.getSnapshot(request.conversationId, 2).then((snapshot) => {
        if (alive && completions.current.accept(request, snapshot)) change();
      }).catch(() => {
        // An unreadable completion produces no notice, never a progress/error message.
      });
    });
    const theme = api.settings.onChanged((settings) => applyThemePreferences(settings as Parameters<typeof applyThemePreferences>[0]));
    return () => { alive = false; listeners.delete(change); off(); theme(); };
  }, [change]);

  const { snapshot, moving } = surface;
  const completion = completions.current.completion;
  const content = completion?.text ?? "";
  const source = completion ? `chat:${completion.conversationId}` : "none";
  const identity = completion ? String(completion.revision) : "none";
  const suppressed = !snapshot?.visible || !snapshot.settings.enabled || snapshot.settings.messages === false
    || snapshot.appFocused === true || !completion;
  const show = visible && !suppressed && !moving;

  useLayoutEffect(() => {
    lifetime.update(source, identity, suppressed);
    lifetime.hover(hovered && !moving);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const sync = (): void => {
      const showing = lifetime.visible;
      setVisible(showing);
      if (showing && !hovered) timer = setTimeout(sync, lifetime.remaining);
      if (!showing) setHovered(false);
    };
    sync();
    return () => clearTimeout(timer);
  }, [source, identity, suppressed, hovered, moving]);

  useLayoutEffect(() => {
    const node = measurement.current;
    if (!node || !show) return;
    let alive = true;
    const measure = (): void => {
      if (!alive) return;
      const rect = node.getBoundingClientRect();
      const next = { width: Math.ceil(rect.width), height: Math.ceil(rect.height) };
      if (next.width <= 0 || next.height <= 0) return;
      setTextSize((previous) => previous?.width === next.width && previous?.height === next.height ? previous : next);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    void document.fonts.ready.then(measure);
    return () => { alive = false; observer.disconnect(); };
  }, [content, show]);

  const height = show ? textSize?.height ?? 0 : 0;
  const width = textSize?.width;
  useEffect(() => { void api.vivi.setBubble(height, 0, width).catch(() => undefined); }, [height, width]);
  const bubble = snapshot?.surface?.bubble;
  return <>
    <span ref={measurement} className="vivi-bubble-measure vivi-bubble-text" aria-hidden="true">{content}</span>
    {show && completion && bubble && bubble.height > 0 ? <div
      className="vivi-agent-bubble vivi-text-bubble pointer-events-auto"
      style={{ position: "absolute", left: bubble.x, top: bubble.y, width: bubble.width, height: bubble.height }}
      onPointerEnter={() => { setHovered(true); void api.vivi.hitTest(true); }}
      onPointerLeave={() => { setHovered(false); void api.vivi.hitTest(false); }}>
      <Button variant="ghost" className="vivi-bubble-text h-full w-full min-w-0 justify-start rounded-[inherit] text-left hover:bg-transparent"
        title={t("vivi.openConversation")} onClick={() => void api.vivi.openConversation(completion.conversationId)}>
        <span className="vivi-notification-content block w-full text-sm font-normal leading-5">{content}</span>
      </Button>
      <Button variant="secondary" size="icon-xs" className="vivi-bubble-close absolute -left-2.5 -top-2.5 size-6 rounded-full border border-border" aria-label={t("vivi.dismiss")}
        onClick={() => { lifetime.dismiss(); setVisible(false); setHovered(false); }}><HugeiconsIcon icon={Cancel01Icon} className="size-3.5" /></Button>
    </div> : null}
  </>;
}

export function mountViviBubble(): () => void {
  applyThemePreferences(api.settings.initial as Parameters<typeof applyThemePreferences>[0]);
  const element = document.getElementById("vivi-bubble-root");
  if (!element) throw new Error("Vivi bubble root is missing");
  const root = createRoot(element);
  root.render(<TooltipProvider><ViviBubble /></TooltipProvider>);
  return () => root.unmount();
}
