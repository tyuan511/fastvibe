import { mountViviBubble, updateViviBubble, setViviBubbleMoving } from "./agent-bubble";
import "./main.css";
import type { ViviDragMotion, ViviSnapshot } from "@shared/vivi";
import { initializeViviScene, type ViviScene } from "../lib/vivi-renderer";

type ViviApi = {
  getSnapshot: () => Promise<ViviSnapshot>;
  rendererState: (ready: boolean, error?: string) => Promise<void>;
  onChanged: (listener: (snapshot: ViviSnapshot) => void) => () => void;
  onDragMotion: (listener: (motion: ViviDragMotion) => void) => () => void;
  motionSettled: (at: number) => Promise<void>;
  dragStart: () => Promise<void>;
  dragEnd: () => Promise<void>;
  openConversation: (conversationId?: string) => Promise<void>;
  contextMenu: () => Promise<void>;
  hitTest?: (interactive: boolean) => Promise<void>;
};

type ViviWindow = Window & {
  fastvibe: Window["fastvibe"] & { vivi: ViviApi };
};

type PointerState = {
  pointerId: number;
  actorId: string;
  startX: number;
  startY: number;
  dragging: boolean;
};

type UiLanguage = "zh" | "en";

const canvasElement = document.querySelector<HTMLCanvasElement>("#vivi-canvas");
const labelsElement = document.querySelector<HTMLDivElement>("#vivi-labels");
const errorTitleElement = document.querySelector<HTMLHeadingElement>("#vivi-error-title");
const errorDetailElement = document.querySelector<HTMLParagraphElement>("#vivi-error-detail");
const retryButtonElement = document.querySelector<HTMLButtonElement>("#vivi-retry");
if (!canvasElement || !labelsElement || !errorTitleElement || !errorDetailElement || !retryButtonElement) {
  throw new Error("Vivi renderer markup is incomplete");
}
const canvas = canvasElement;
const labels = labelsElement;
const errorTitle = errorTitleElement;
const errorDetail = errorDetailElement;
const retryButton = retryButtonElement;

const api = (window as ViviWindow).fastvibe.vivi;
const notificationOnly = new URLSearchParams(window.location.search).get("notification") === "1";
const unmountBubble = notificationOnly ? mountViviBubble() : undefined;
if (notificationOnly) canvas.style.display = "none";
let scene: ViviScene | undefined;
let unsubscribe: (() => void) | undefined;
let unsubscribeMotion: (() => void) | undefined;
let latestSnapshot: ViviSnapshot | undefined;
let pointer: PointerState | undefined;
let hoveredActorId: string | null = null;
let bubbledActorId: string | null = null;
let bubbleTimer: ReturnType<typeof setTimeout> | undefined;
let lastClick: { actorId: string; at: number } | undefined;
let destroyed = false;
let dragRequests = Promise.resolve();

function queueDragRequest(action: () => Promise<void>): void {
  dragRequests = dragRequests.then(action, action).catch((error) => {
    console.error("Vivi drag request failed", error);
  });
}

function languageFor(snapshot?: ViviSnapshot): UiLanguage {
  const requested = (snapshot as (ViviSnapshot & { uiLanguage?: string }) | undefined)?.uiLanguage;
  if (requested?.toLowerCase().startsWith("zh")) return "zh";
  if (requested?.toLowerCase().startsWith("en")) return "en";
  return navigator.language.toLowerCase().startsWith("zh") ? "zh" : "en";
}

function text(snapshot: ViviSnapshot | undefined, zh: string, en: string): string {
  return languageFor(snapshot) === "zh" ? zh : en;
}

function setError(message: string | undefined, snapshot = latestSnapshot): void {
  const visible = Boolean(message);
  document.body.classList.toggle("has-error", visible);
  errorTitle.textContent = text(snapshot, "Vivi 暂时无法显示", "Vivi could not be displayed");
  errorDetail.textContent = message ?? text(snapshot, "请重试。", "Please try again.");
  retryButton.textContent = text(snapshot, "重试", "Retry");
  retryButton.disabled = false;
  retryButton.setAttribute("aria-label", retryButton.textContent);
}

function readableLoadError(error: unknown, snapshot = latestSnapshot): string {
  const detail = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  if (detail.includes("model") || detail.includes("gltf") || detail.includes("404") || detail.includes("fetch")) {
    return text(snapshot, "Vivi 模型加载失败，请重试。", "The Vivi model could not be loaded. Please try again.");
  }
  return text(snapshot, "Vivi 初始化失败，请重试。", "Vivi could not start. Please try again.");
}

function setActors(snapshot: ViviSnapshot): void {
  const activeScene = scene;
  if (!activeScene) return;
  const bounds = snapshot.surface?.pet;
  if (bounds) {
    // The model has its own native frame; notification offsets belong only to
    // the text window and must never rebase this canvas after a native move.
    canvas.style.left = "0px";
    canvas.style.top = "0px";
    canvas.style.width = `${bounds.width}px`;
    canvas.style.height = `${bounds.height}px`;
  }
  activeScene.setActors(snapshot.actors);
  activeScene.setClickable(snapshot.settings.clickable);
  activeScene.setVisible(snapshot.visible && snapshot.settings.enabled !== false);
  document.body.style.setProperty("--vivi-opacity", String(Math.max(0, Math.min(1, snapshot.settings.opacity))));
  renderLabels(snapshot);
}

function notifyHitTest(interactive: boolean): void {
  try {
    void api.hitTest?.(interactive);
  } catch {
    // A renderer can be paired with an older preload while the window is reloaded.
  }
}

function renderLabels(snapshot = latestSnapshot): void {
  if (!snapshot || !scene || !labels) return;
  labels.replaceChildren();
  const actorId = bubbledActorId;
  if (!actorId) return;
  const actor = snapshot.actors.find((candidate) => candidate.id === actorId);
  const position = scene.getActorScreenPosition(actorId);
  if (!actor || !position) return;
  const labelsRect = labels.getBoundingClientRect();
  const label = document.createElement("div");
  label.className = "vivi-bubble";
  label.textContent = actor.label;
  label.style.left = `${position.x - labelsRect.left}px`;
  label.style.top = `${position.y - labelsRect.top}px`;
  label.setAttribute("aria-label", actor.label);
  labels.append(label);
}

function showBubble(actorId: string): void {
  bubbledActorId = actorId;
  if (bubbleTimer) clearTimeout(bubbleTimer);
  bubbleTimer = setTimeout(() => {
    bubbleTimer = undefined;
    bubbledActorId = null;
    renderLabels();
  }, 1700);
  renderLabels();
}

function actorAt(event: PointerEvent): string | null {
  return scene?.hitTest(event.clientX, event.clientY) ?? null;
}

function safeCall(action: () => Promise<unknown>): void {
  void action().catch((error) => {
    console.error("Vivi IPC request failed", error);
  });
}

function finishPointer(event?: PointerEvent): void {
  const current = pointer;
  pointer = undefined;
  if (!current) return;
  if (canvas.hasPointerCapture(current.pointerId)) canvas.releasePointerCapture(current.pointerId);
  if (current.dragging) {
    lastClick = undefined;
    queueDragRequest(() => api.dragEnd());
  }
  if (event) event.preventDefault();
}

function handlePointerMove(event: PointerEvent): void {
  if (pointer?.pointerId === event.pointerId && (event.buttons & 1) === 0) {
    finishPointer(event);
    return;
  }
  const actorId = actorAt(event);
  if (actorId !== hoveredActorId) {
    hoveredActorId = actorId;
    notifyHitTest(Boolean(actorId || pointer));
    renderLabels();
  }
  const current = pointer;
  if (!current || current.pointerId !== event.pointerId || current.dragging) return;
  const distance = Math.hypot(event.clientX - current.startX, event.clientY - current.startY);
  if (distance < 5) return;
  current.dragging = true;
  queueDragRequest(async () => {
    if (destroyed || pointer !== current || !current.dragging) return;
    await api.dragStart();
  });
  event.preventDefault();
}

function handlePointerDown(event: PointerEvent): void {
  if (event.button !== 0 || !latestSnapshot?.settings.clickable) return;
  const actorId = actorAt(event);
  if (!actorId) return;
  finishPointer();
  pointer = { pointerId: event.pointerId, actorId, startX: event.clientX, startY: event.clientY, dragging: false };
  canvas.setPointerCapture(event.pointerId);
  notifyHitTest(true);
  event.preventDefault();
}

function handlePointerUp(event: PointerEvent): void {
  const current = pointer;
  if (!current || current.pointerId !== event.pointerId) return;
  const wasDragging = current.dragging;
  finishPointer(event);
  if (wasDragging || !latestSnapshot?.settings.clickable) return;
  const now = performance.now();
  const isDouble = lastClick?.actorId === current.actorId && now - lastClick.at < 340;
  lastClick = isDouble ? undefined : { actorId: current.actorId, at: now };
  if (isDouble) {
    const actor = latestSnapshot.actors.find((candidate) => candidate.id === current.actorId);
    safeCall(() => api.openConversation(actor?.conversationId));
    return;
  }
  scene?.poke(current.actorId);
}

function handlePointerCancel(event: PointerEvent): void {
  if (pointer?.pointerId === event.pointerId) finishPointer(event);
}

function handleWindowPointerMove(event: PointerEvent): void {
  if (pointer?.pointerId === event.pointerId && (event.buttons & 1) === 0) finishPointer(event);
}

function handlePointerLeave(): void {
  if (pointer) return;
  if (hoveredActorId !== null) {
    hoveredActorId = null;
    notifyHitTest(false);
    renderLabels();
  }
}

function handleContextMenu(event: MouseEvent): void {
  event.preventDefault();
  safeCall(() => api.contextMenu());
}

function onWindowBlur(): void {
  if (pointer) finishPointer();
}

async function applySnapshot(snapshot: ViviSnapshot): Promise<void> {
  if (destroyed) return;
  latestSnapshot = snapshot;
  if (notificationOnly) {
    setViviBubbleMoving(snapshot.moving === true);
    updateViviBubble(snapshot);
    return;
  }
  setError(snapshot.error);
  setActors(snapshot);
  if (snapshot.error) console.error("Vivi reported an error", snapshot.error);
}

async function load(): Promise<void> {
  if (destroyed) return;
  finishPointer();
  unsubscribeMotion?.();
  unsubscribeMotion = undefined;
  setError(undefined);
  scene?.cleanup();
  scene = undefined;
  try {
    await api.rendererState(false);
    if (notificationOnly) {
      // Subscribe before the read, and do not apply a stale read over a live push.
      let received = false;
      unsubscribe = api.onChanged((snapshot) => { received = true; void applySnapshot(snapshot); });
      const snapshot = await api.getSnapshot();
      if (!received) await applySnapshot(snapshot);
      await api.rendererState(true);
      return;
    }
    const nextScene = await initializeViviScene(canvas, (at) => safeCall(() => api.motionSettled(at)));
    if (destroyed) {
      nextScene.cleanup();
      return;
    }
    scene = nextScene;
    unsubscribeMotion = api.onDragMotion((motion) => {
      scene?.setDragMotion(motion);
    });
    const snapshot = await api.getSnapshot();
    unsubscribe?.();
    unsubscribe = api.onChanged((nextSnapshot) => void applySnapshot(nextSnapshot));
    await applySnapshot(snapshot);
    scene.prepareFrame();
    await api.rendererState(true);
    renderLabels(snapshot);
  } catch (error) {
    console.error("Failed to initialize Vivi", error);
    const message = readableLoadError(error);
    setError(message);
    await api.rendererState(false, message).catch(() => undefined);
  }
}

retryButton.addEventListener("click", () => void load());
canvas.addEventListener("pointerdown", handlePointerDown, { passive: false });
canvas.addEventListener("pointermove", handlePointerMove, { passive: false });
canvas.addEventListener("pointerup", handlePointerUp, { passive: false });
canvas.addEventListener("pointercancel", handlePointerCancel, { passive: false });
canvas.addEventListener("lostpointercapture", handlePointerCancel, { passive: false });
window.addEventListener("pointerup", handlePointerUp, { capture: true, passive: false });
window.addEventListener("pointercancel", handlePointerCancel, { capture: true, passive: false });
window.addEventListener("pointermove", handleWindowPointerMove, { capture: true, passive: false });
canvas.addEventListener("pointerleave", handlePointerLeave);
canvas.addEventListener("contextmenu", handleContextMenu);
window.addEventListener("pointermove", (event) => {
  const target = event.target;
  const overBubble = target instanceof Element && target.closest(".vivi-agent-bubble") !== null;
  notifyHitTest(Boolean(pointer || overBubble || scene?.hitTest(event.clientX, event.clientY)));
}, { capture: true });
window.addEventListener("blur", onWindowBlur);
window.addEventListener("resize", () => renderLabels());

document.addEventListener("visibilitychange", () => {
  if (document.hidden && pointer) finishPointer();
  if (!document.hidden) renderLabels();
});

window.addEventListener("beforeunload", () => {
  destroyed = true;
  unsubscribe?.();
  unsubscribe = undefined;
  unsubscribeMotion?.();
  unsubscribeMotion = undefined;
  if (bubbleTimer) clearTimeout(bubbleTimer);
  unmountBubble?.();
  finishPointer();
  scene?.cleanup();
  scene = undefined;
});

void load();
