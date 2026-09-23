import { useEffect, useRef, useState, type FormEvent, type JSX } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { i18n } from "@/lib/i18n";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  ArrowDown01Icon,
  ArrowLeft01Icon,
  ArrowRight01Icon,
  ArrowUp01Icon,
  ChromeIcon,
  ComputerIcon,
  Copy01Icon,
  CursorRectangleSelection01Icon,
  Delete02Icon,
  LinkSquare02Icon,
  MoreHorizontalIcon,
  Refresh01Icon,
  Search01Icon,
  SmartPhone01Icon,
  Tablet01Icon,
  Tick02Icon,
  Upload01Icon,
  ZoomInAreaIcon,
  ZoomOutAreaIcon,
} from "@hugeicons/core-free-icons";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import { blockedRemotely } from "@/lib/remote-unavailable";
import { useSessionStore } from "@/stores/session";
import { useSidePaneStore } from "@/stores/side-pane";
import { clickBody, pageProgram, pressBody, SNAPSHOT_BODY, typeBody } from "@shared/browser-page";
import { Ipc } from "@shared/ipc";
import type { BrowserImportResult, BrowserProfileInfo, BrowserRequest, ChatAttachment } from "@shared/types";

function be(key: string, options?: Record<string, unknown>): string {
  return i18n.t(`sidepane:browser.${key}`, options) as string;
}

/** Retained as the renderer-side name for the shared browser-use protocol. */
export type BrowserAutomationRequest = BrowserRequest;

type Guest = HTMLElement & {
  src: string;
  getURL(): string;
  getTitle(): string;
  canGoBack(): boolean;
  canGoForward(): boolean;
  goBack(): void;
  goForward(): void;
  reload(): void;
  loadURL(url: string): void;
  executeJavaScript(code: string): Promise<unknown>;
  isLoading(): boolean;
  sendInputEvent(event: Record<string, unknown>): void;
  selectAll(): void;
  insertText(text: string): Promise<void>;
  setZoomFactor(factor: number): void;
  getZoomFactor(): number;
  setUserAgent(userAgent: string): void;
  getUserAgent(): string;
  findInPage(text: string, options?: { forward?: boolean; findNext?: boolean }): number;
  stopFindInPage(action: "clearSelection" | "keepSelection" | "activateSelection"): void;
};

type FaviconEvent = Event & { favicons?: string[] };

function pickFavicon(urls: string[] | undefined): string | undefined {
  return urls?.find((href) => /^(https?:|data:)/i.test(href));
}

function originFavicon(href: string): string | undefined {
  try {
    const parsed = new URL(href);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined;
    return `${parsed.origin}/favicon.ico`;
  } catch {
    return undefined;
  }
}

type Entry = {
  id: string;
  host: HTMLDivElement;
  view: Guest;
  /** The guest cannot executeJavaScript until its first dom-ready event. */
  ready: Promise<void>;
  /**
   * Last page this tab was known to be on. A tab whose guest died can no longer
   * answer `getURL`, and its replacement has to resume the same page — otherwise an
   * auto-recovered call would quietly answer from the wrong document.
   */
  url: string;
};

/** How the injected page scripts report success and failure. */
type Injected = { ok: boolean; value?: unknown; error?: string };

const registry = new Map<string, Entry>();

/**
 * The one container every browser guest lives in.
 *
 * A `<webview>` may not be moved in the DOM: re-parenting it tears the guest down
 * (Chromium invalidates the guest instance and never re-attaches it), so a guest
 * that was created off-screen and then "moved into" the pane arrived dead — which
 * is exactly what opening the browser from a tool did. The dead tab was retired by
 * `usable()`, retiring the last tab collapsed the pane, and the user saw the pane
 * flash open and close.
 *
 * So guests are never moved. The layer is created once, attached to `document.body`
 * and *positioned*: parked off-screen while its tab is not the one on screen, and
 * stretched over that tab's viewport while it is. A parked host stays laid out — a
 * hidden or detached `<webview>` never mints a guest — so browser-use in a
 * background chat, or on a collapsed pane, keeps working without showing anything.
 */
let layer: HTMLDivElement | null = null;
/** The tab whose guest currently owns the viewport (null: the layer is parked). */
let owner: string | null = null;

const PARKED_LAYER =
  "position:fixed;left:-10000px;top:0;width:1024px;height:768px;overflow:hidden;pointer-events:none;z-index:5;";
const SHOWN_HOST = "position:absolute;left:0;top:0;width:100%;height:100%;";
const HIDDEN_HOST = "position:absolute;left:-20000px;top:0;width:1024px;height:768px;";

/**
 * Viewport presets the bottom bar offers. Responsive is the pane itself at 100%;
 * the two devices are CSS pixels, matching Chrome's device mode, and the page is
 * laid out at that width while the pane stays whatever size the user dragged it to.
 */
type ViewportMode = "responsive" | "mobile" | "tablet";
const VIEWPORTS: Record<Exclude<ViewportMode, "responsive">, { width: number; height: number }> = {
  mobile: { width: 375, height: 812 },
  tablet: { width: 768, height: 1024 },
};
const ZOOM_STEPS = [0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2];
/** How much of a picked element's text rides along as the chip's readable content. */
const PICK_TEXT_LIMIT = 8_000;

const PICK_BODY = `
  if (window.__fvPick) return { listening: true };
  const box = document.createElement("div");
  box.style.cssText = "position:fixed;z-index:2147483646;pointer-events:none;border:2px solid #1a73e8;background:rgba(26,115,232,.12);border-radius:2px;display:none;";
  const label = document.createElement("div");
  label.style.cssText = "position:fixed;z-index:2147483647;pointer-events:none;background:#1a73e8;color:#fff;font:12px/1.4 -apple-system,sans-serif;padding:2px 6px;border-radius:4px;display:none;max-width:320px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;";
  document.documentElement.append(box, label);
  const describe = (node) => {
    const tag = node.tagName.toLowerCase();
    const id = node.id ? "#" + node.id : "";
    const cls = typeof node.className === "string" && node.className.trim()
      ? "." + node.className.trim().split(/\\s+/).slice(0, 2).join(".")
      : "";
    return tag + id + cls;
  };
  const onMove = (event) => {
    const node = event.target;
    if (!(node instanceof Element) || node === box || node === label) return;
    const rect = node.getBoundingClientRect();
    box.style.display = "block";
    box.style.left = rect.left + "px";
    box.style.top = rect.top + "px";
    box.style.width = rect.width + "px";
    box.style.height = rect.height + "px";
    label.style.display = "block";
    label.textContent = describe(node);
    label.style.left = Math.max(4, rect.left) + "px";
    label.style.top = Math.max(4, rect.top - 22) + "px";
  };
  const onClick = (event) => {
    const node = event.target;
    if (!(node instanceof Element)) return;
    event.preventDefault();
    event.stopPropagation();
    const text = (node.innerText || node.textContent || "").replace(/\\s+/g, " ").trim().slice(0, ${PICK_TEXT_LIMIT});
    const html = (node.outerHTML || "").slice(0, ${PICK_TEXT_LIMIT});
    window.__fvPicked = { selector: describe(node), tag: node.tagName.toLowerCase(), text, html, url: location.href };
  };
  document.addEventListener("mousemove", onMove, true);
  document.addEventListener("click", onClick, true);
  window.__fvPick = { box, label, onMove, onClick };
  return { listening: true };
`;

const PICK_READ_BODY = `
  const picked = window.__fvPicked || null;
  const stop = window.__fvPick;
  if (stop) {
    document.removeEventListener("mousemove", stop.onMove, true);
    document.removeEventListener("click", stop.onClick, true);
    stop.box.remove();
    stop.label.remove();
    delete window.__fvPick;
  }
  delete window.__fvPicked;
  return picked;
`;

function getLayer(): HTMLDivElement {
  if (!layer) {
    layer = document.createElement("div");
    layer.setAttribute("data-side-pane-browser-layer", "");
    layer.style.cssText = PARKED_LAYER;
    document.body.appendChild(layer);
  }
  return layer;
}

/**
 * The pane animates by clipping a fixed-width frame, so the browser viewport's own
 * rect never changes while the panel opens. The nearest clipping ancestor is what
 * makes the guest follow the animation instead of appearing at full width over the
 * conversation column.
 */
function clipAncestor(node: HTMLElement): HTMLElement | null {
  for (let el = node.parentElement; el; el = el.parentElement) {
    const style = getComputedStyle(el);
    if (style.overflowX === "hidden" || style.overflowY === "hidden") return el;
  }
  return null;
}

/** The part of the browser viewport actually on screen. */
function visibleRect(
  node: HTMLElement,
  clip: HTMLElement | null,
): { left: number; top: number; width: number; height: number } {
  const box = node.getBoundingClientRect();
  // The splitter is a flex item beside the pane, not an overlay inside it, so the
  // pane's own left edge is already clear of it — nothing to carve out here.
  let left = box.left;
  let right = box.right;
  let top = box.top;
  let bottom = box.bottom;
  if (clip) {
    const frame = clip.getBoundingClientRect();
    // While the pane slides open the clip is still left of the frame it will settle
    // at; never let the guest paint over the conversation column.
    left = Math.max(left, frame.left);
    right = Math.min(right, frame.right);
    top = Math.max(top, frame.top);
    bottom = Math.min(bottom, frame.bottom);
  }
  return {
    left,
    top,
    width: Math.max(0, right - left),
    height: Math.max(0, bottom - top),
  };
}

/**
 * Stretch the layer over one guest's viewport and bring that guest forward. Only
 * CSS changes here — the `<webview>` itself is never re-parented.
 */
function showGuest(entry: Entry, rect: { left: number; top: number; width: number; height: number }): void {
  const node = getLayer();
  if (owner !== entry.id) {
    owner = entry.id;
    for (const item of registry.values()) {
      item.host.style.cssText = item === entry ? SHOWN_HOST : HIDDEN_HOST;
    }
  }
  node.style.left = `${Math.round(rect.left)}px`;
  node.style.top = `${Math.round(rect.top)}px`;
  node.style.width = `${Math.round(rect.width)}px`;
  node.style.height = `${Math.round(rect.height)}px`;
  node.style.pointerEvents = "auto";
}

/**
 * Lay a device viewport out inside the pane's box.
 *
 * The guest has to be laid out *at the preset's own CSS pixels* — a host merely
 * drawn smaller still reports the pane's width to the page, which is why picking
 * Mobile changed nothing. So the host stays the preset size and is scaled down to
 * fit, centred, with the layer's own background letterboxing whatever is left.
 */
function placeDevice(entry: Entry, mode: ViewportMode, box: { width: number; height: number }): void {
  if (mode === "responsive" || box.width <= 0 || box.height <= 0) {
    entry.host.style.cssText = SHOWN_HOST;
    return;
  }
  const preset = VIEWPORTS[mode];
  const scale = Math.min(1, box.width / preset.width, box.height / preset.height);
  const left = Math.max(0, (box.width - preset.width * scale) / 2);
  const top = Math.max(0, (box.height - preset.height * scale) / 2);
  entry.host.style.cssText = [
    "position:absolute",
    "transform-origin:top left",
    `left:${left}px`,
    `top:${top}px`,
    `width:${preset.width}px`,
    `height:${preset.height}px`,
    `transform:scale(${scale})`,
    "box-shadow:0 0 0 1px rgba(0,0,0,.18)",
    "background:#fff",
  ].join(";");
}

/** Stop showing a guest, but only if it is the one that owns the viewport. */
function parkGuest(tabId: string): void {
  if (owner !== tabId) return;
  owner = null;
  if (layer) layer.style.cssText = PARKED_LAYER;
}

/** Side-chat tools belong on the parent conversation's pane, not a hidden scope. */
function paneConversationId(conversationId?: string): string | undefined {
  if (!conversationId) return undefined;
  const conversation = useSessionStore.getState().conversations.find((item) => item.id === conversationId);
  return conversation?.parentId || conversationId;
}

function createGuest(tabId: string, url: string): Entry {
  const host = document.createElement("div");
  host.className = "h-full min-h-0 w-full";
  host.style.cssText = HIDDEN_HOST;
  const view = document.createElement("webview") as Guest;
  view.setAttribute("allowpopups", "true");
  // A page's alert/confirm/prompt is a native modal by default: it lands in front of the
  // user *and* blocks the guest, so a tool call waits on a button nobody is there to
  // press. Auto-dismissed instead, page JS keeps running — `confirm` answers false, which
  // is what a browser with dialogs switched off does too. Popups are a different door,
  // closed in main (`guardGuestPopups`).
  view.setAttribute("webpreferences", "disableDialogs=true");
  view.setAttribute("partition", "persist:fastvibe-browser");
  view.style.width = "100%";
  view.style.height = "100%";
  view.style.backgroundColor = "#fff";
  let resolveReady!: () => void;
  const ready = new Promise<void>((resolve) => {
    resolveReady = resolve;
  });
  view.addEventListener("dom-ready", () => resolveReady());
  host.appendChild(view);
  const href = normalizeUrl(url);
  const entry: Entry = { id: tabId, host, view, ready, url: href };
  registry.set(tabId, entry);
  // Mount before assigning src. A detached `<webview>` can accept the property
  // but never creates a guest.
  getLayer().appendChild(host);
  view.src = href;
  return entry;
}

function ensureGuest(tabId: string, url: string): Entry {
  return registry.get(tabId) ?? createGuest(tabId, url);
}

const SEARCH_ENGINE = "https://www.google.com/search?q=";

/** What an address-less tab loads: an empty page, never a site the app picked. */
const BLANK_PAGE = "about:blank";

function normalizeUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return BLANK_PAGE;
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return trimmed;
  // Treat spaces, CJK text, and bare words as a search query. Host-like input
  // (including localhost and IPv4) remains a direct navigation.
  if (/\s/u.test(trimmed) || /[^\x00-\x7f]/u.test(trimmed) || (!trimmed.includes(".") && !/^localhost(?::\d+)?$/i.test(trimmed))) {
    return `${SEARCH_ENGINE}${encodeURIComponent(trimmed)}`;
  }
  return `https://${trimmed}`;
}

function safe<T>(read: () => T, fallback: T): T {
  try {
    return read();
  } catch {
    return fallback;
  }
}

/**
 * Keep `entry.url` current, as best a guest that may already be gone can answer.
 * A blank page clears it: "no page" is what a recovery, a reload or a bare
 * `browser_open` should act on, not the site the tab happened to be on before.
 */
function rememberUrl(entry: Entry): void {
  const href = safe(() => entry.view.getURL(), "");
  if (href && href !== BLANK_PAGE) entry.url = href;
  else if (href === BLANK_PAGE) entry.url = "";
}

/** Attach a note to a result the model reads, leaving its shape otherwise alone. */
function withNote(value: unknown, note?: string): unknown {
  return note && value && typeof value === "object"
    ? { ...(value as Record<string, unknown>), note }
    : value;
}

/** Tab ids this conversation (or the pane on screen) can legitimately address. */
function openTabIds(conversationId?: string): string[] {
  const paneId = paneConversationId(conversationId);
  const scoped = useSidePaneStore.getState().browserTabIds(paneId).filter((id) => registry.has(id));
  if (scoped.length > 0 || paneId) return scoped;
  return [...registry.keys()];
}

type Resolved = { entry: Entry; note?: string };

/**
 * Find the tab a request means. A stale id is a common tool-call failure (the user
 * closed the tab, or the app retired it), and refusing the call makes the model
 * re-open a page it already has, so an only open tab is adopted instead — with a
 * note in the result saying so. An omitted id means "the tab I have open last".
 * Background chats only see their own tabs, so they cannot drive another chat's page.
 */
function resolveEntry(tabId?: string, conversationId?: string): Resolved {
  const ids = openTabIds(conversationId);
  const allowed = new Set(ids);
  const direct = tabId && allowed.has(tabId) ? registry.get(tabId) : undefined;
  if (direct) return { entry: direct };
  if (ids.length === 0) throw new Error(be("noTabs"));
  if (!tabId) return { entry: registry.get(ids[ids.length - 1]) as Entry, note: be("usedLatest") };
  if (ids.length === 1) return { entry: registry.get(ids[0]) as Entry, note: be("staleAdopted", { tabId }) };
  throw new Error(be("missingTab", { tabId, ids: ids.join(", ") }));
}

/**
 * A tab whose guest is gone. The tab is retired before this is thrown, so the request
 * that found it can finish on a replacement instead of handing the model an error it
 * can only answer by calling `browser_open` again.
 */
class TabGoneError extends Error {
  constructor(
    readonly tabId: string,
    readonly url: string,
    message: string,
  ) {
    super(message);
    this.name = "TabGoneError";
  }
}

/**
 * Retire a tab whose guest can no longer run scripts: drop it from the registry and
 * close its pane tab. A webview whose guest is gone never comes back, so the next call
 * that addresses the tab mints a replacement rather than retrying a corpse.
 */
function retire(tabId: string): void {
  if (!registry.has(tabId)) return;
  releaseBrowser(tabId);
  // Never collapses: the caller is about to mint a replacement, and collapsing the
  // pane around it (then expanding again) is the flash this path must not produce.
  useSidePaneStore.getState().close(tabId, { collapse: false });
}

/** Retire a tab whose guest is gone, and report it so the caller can replace it. */
function gone(entry: Entry): TabGoneError {
  const url = entry.url;
  retire(entry.id);
  return new TabGoneError(entry.id, url, be("tabGone"));
}

async function execute(entry: Entry, code: string): Promise<unknown> {
  if (typeof entry.view.executeJavaScript !== "function") throw new Error(be("noExecute"));
  try {
    return await entry.view.executeJavaScript(code);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // Electron reports a rejected injection with this opaque text when the script
    // never compiles or the guest is gone — the page ran no line of it. Keep the
    // real reason in the console; `TabGoneError` lets the request retry on a fresh tab.
    if (/Script failed to execute/i.test(message)) {
      console.error("[browser-use] injected script was rejected by the guest", error, code);
      // Patient: a script interrupted by its own navigation is not a dead tab.
      if (await ensureAlive(entry)) {
        throw new Error(be("scriptNav"));
      }
      throw gone(entry);
    }
    if (/GUEST_VIEW_MANAGER_CALL|destroyed|was disposed|Render frame/i.test(message)) {
      throw gone(entry);
    }
    throw new Error(be("scriptFailed", { message }));
  }
}

/** A webview whose guest is gone still answers its JS wrapper; probing `getURL`
 * is the cheap way to tell a live tab from a corpse. */
function guestAlive(entry: Entry): boolean {
  if (!entry.host.isConnected) return false;
  return safe(
    () => {
      entry.view.getURL();
      return true;
    },
    false,
  );
}

/**
 * The same probe, but patient: a tab that was just minted can still be settling when
 * the first call arrives, and retiring a healthy tab would be worse than the failure
 * it was meant to prevent.
 */
async function ensureAlive(entry: Entry): Promise<boolean> {
  for (let attempt = 0; attempt < 3; attempt++) {
    if (guestAlive(entry)) return true;
    await new Promise((resolve) => window.setTimeout(resolve, 150));
  }
  return false;
}

/**
 * A tab a request can actually run on: the guest reached dom-ready, and it still
 * answers. A guest that never gets there is as dead as one that threw, and either way
 * the caller's answer is a replacement tab — never an error.
 */
async function usable(entry: Entry): Promise<boolean> {
  try {
    await waitForReady(entry);
  } catch {
    return false;
  }
  return ensureAlive(entry);
}

/**
 * Run a script inside the guest and hand back its value.
 * The body is wrapped so a page-side throw comes back as data (`{ ok: false, error }`)
 * instead of Electron's opaque "Script failed to execute" rejection, which tells the
 * model and the user nothing actionable (and makes the model retry the same call
 * forever). The value is JSON round-tripped so a non-cloneable return — a DOM node, a
 * function — cannot break the call either.
 */
async function inject(entry: Entry, body: string): Promise<unknown> {
  const result = (await execute(entry, pageProgram(body))) as Injected | undefined;
  if (!result || typeof result !== "object") throw new Error(be("invalidResult"));
  if (!result.ok) throw new Error(be("opFailed", { error: result.error ?? be("scriptError") }));
  return result.value;
}

/**
 * Run a page script for an action that may navigate.
 *
 * A click that loads a document can destroy the execution context before the guest
 * hands the script's result back — Electron reports that as the same opaque
 * "Script failed to execute" as a broken script, and it is a large share of what a
 * browsing session hits. The navigation is the evidence the action worked, so a
 * failure within the navigation window is reported as a success with a warning
 * rather than failing the tool call.
 */
async function act(
  entry: Entry,
  body: string,
  fallback: Record<string, unknown>,
  grace = 500,
): Promise<Record<string, unknown>> {
  const navigated = waitForNavigation(entry.view, grace);
  let outcome: Record<string, unknown>;
  try {
    outcome = (await inject(entry, body)) as Record<string, unknown>;
  } catch (error) {
    // A navigation that destroyed the guest is the click having worked; anything else,
    // including a tab that is gone for good, must reach the caller.
    if (error instanceof TabGoneError || !(await navigated)) throw error;
    outcome = fallback;
  }
  // Read the URL after the navigation settles, so a click that moved the page reports
  // (and remembers) where it landed rather than the document it left.
  const navigatedTo = await navigated;
  rememberUrl(entry);
  return { ...outcome, navigated: navigatedTo, url: entry.url };
}

type LoadOutcome = { loaded: boolean; settled: boolean; error?: string };

/**
 * Load a URL and wait for the page to stop loading, so the next snapshot sees the
 * new document rather than the one that is on its way out. A main-frame failure is
 * reported instead of thrown: an unreachable host is the model's problem to handle,
 * not a tool crash.
 */
function loadUrl(view: Guest, url: string, timeout = 20_000): Promise<LoadOutcome> {
  return new Promise((resolve) => {
    let timer: number | undefined;
    let failure: string | undefined;
    const finish = (loaded: boolean, settled: boolean): void => {
      if (timer !== undefined) window.clearTimeout(timer);
      view.removeEventListener("did-stop-loading", onStop);
      view.removeEventListener("did-fail-load", onFail);
      resolve({ loaded, settled, error: failure });
    };
    const onStop = (): void => finish(!failure, true);
    const onFail = (event: Event): void => {
      const detail = event as Event & { errorCode?: number; errorDescription?: string; isMainFrame?: boolean };
      if (detail.isMainFrame === false) return;
      failure = `${detail.errorDescription ?? be("loadFailed")} (${detail.errorCode ?? "?"})`;
    };
    view.addEventListener("did-stop-loading", onStop);
    view.addEventListener("did-fail-load", onFail);
    timer = window.setTimeout(() => finish(!failure, false), timeout);
    try {
      view.loadURL(url);
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
      finish(false, true);
    }
  });
}

/**
 * Wait for a navigation a click or keypress may have started. A page that stays put
 * resolves after `grace`, so an ordinary click never costs more than that — but a
 * click that loads a new document is awaited before the next snapshot runs.
 */
function waitForNavigation(view: Guest, grace = 500, timeout = 20_000): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false;
    let graceTimer: number | undefined;
    let stopTimer: number | undefined;
    const finish = (navigated: boolean): void => {
      if (done) return;
      done = true;
      if (graceTimer !== undefined) window.clearTimeout(graceTimer);
      if (stopTimer !== undefined) window.clearTimeout(stopTimer);
      view.removeEventListener("did-start-loading", onStart);
      view.removeEventListener("did-stop-loading", onStop);
      resolve(navigated);
    };
    const onStart = (): void => {
      if (stopTimer !== undefined) window.clearTimeout(stopTimer);
      stopTimer = window.setTimeout(() => finish(true), timeout);
    };
    const onStop = (): void => finish(true);
    view.addEventListener("did-start-loading", onStart);
    view.addEventListener("did-stop-loading", onStop);
    graceTimer = window.setTimeout(() => finish(false), grace);
  });
}

async function waitForReady(entry: Entry, timeout = 15_000): Promise<void> {  let timer: number | undefined;
  try {
    await Promise.race([
      entry.ready,
      new Promise<void>((_, reject) => {
        timer = window.setTimeout(() => reject(new Error(be("domReadyTimeout"))), timeout);
      }),
    ]);
  } finally {
    if (timer !== undefined) window.clearTimeout(timer);
  }
}

/**
 * Open (or reuse) the side pane's browser tab.
 *
 * Reuse is the default: minting a Chromium guest per call made a longer browsing
 * session slow and every later call prone to timeouts.
 */
async function openBrowserTab(request: BrowserAutomationRequest): Promise<unknown> {
  const store = useSidePaneStore.getState();
  const paneId = paneConversationId(request.conversationId);
  const url = request.url ?? "";
  // A pane tab can outlive its Chromium guest (the page crashed, the guest was torn
  // down between turns). The caller asked for this page either way, so a dead tab is
  // replaced here and the call finishes — no error for the model to recover from.
  let tabId = "";
  let entry: Entry | undefined;
  let reused = false;
  let replaced = false;
  for (let attempt = 0; attempt < 2 && !entry; attempt++) {
    const existing = request.newTab || replaced ? undefined : store.browserTabIds(paneId)[0];
    reused = Boolean(existing);
    tabId = existing ?? store.openBrowser(url, paneId);
    const candidate = ensureGuest(tabId, url);
    if (await usable(candidate)) {
      entry = candidate;
      break;
    }
    retire(tabId);
    replaced = true;
  }
  if (!entry) throw new Error(be("createFailed"));
  const note = replaced ? be("replaced") : undefined;
  if (!request.url) {
    // No URL asked for: the tab is (or was just made) an empty page. An already-open
    // tab is left where it is — this pane is shared with the user, and clearing a page
    // they are reading to satisfy a bare `browser_open` would be a worse surprise than
    // reusing it. The reply says which page the tab is actually on.
    rememberUrl(entry);
    return withNote({ tabId, url: entry.url || BLANK_PAGE }, note);
  }
  // A tab the store minted with this URL is already loading it; a reused tab (or one
  // opened without a URL) is navigated here.
  if (request.newTab && !reused) {
    await waitForNavigation(entry.view);
    rememberUrl(entry);
    return withNote({ tabId, url: entry.url, loaded: true, settled: true }, note);
  }
  const outcome = await loadUrl(entry.view, normalizeUrl(request.url));
  rememberUrl(entry);
  return withNote({ tabId, url: entry.url, ...outcome }, note);
}

/** Handle browser-use requests arriving from the main-process extension tool. */
export async function handleBrowserRequest(request: BrowserAutomationRequest): Promise<unknown> {
  if (request.action === "open") return openBrowserTab(request);
  if (request.action === "list") {
    return openTabIds(request.conversationId).map((tabId) => {
      const entry = registry.get(tabId);
      return {
        tabId,
        url: entry ? safe(() => entry.view.getURL(), "") : "",
        title: entry ? safe(() => entry.view.getTitle(), "") : "",
        alive: entry ? guestAlive(entry) : false,
      };
    });
  }
  const { entry, note } = resolveEntry(request.tabId, request.conversationId);
  // GUEST_VIEW_MANAGER_CALL rejects calls made before the guest has reached
  // dom-ready. This also covers a tool call issued immediately after opening
  // a tab, before React has observed the first navigation event. A guest that never
  // reaches it is dead: retire it and answer on a replacement below.
  let target = entry;
  let recovery: string | undefined;
  if (!(await usable(entry))) {
    target = await replace(entry.id, entry.url, request);
    recovery = be("recovered");
  }
  let outcome: unknown;
  for (let attempt = 0; ; attempt++) {
    try {
      outcome = await dispatch(request, target);
      break;
    } catch (error) {
      if (!(error instanceof TabGoneError)) throw error;
      // The tab the model addressed is retired by now, but the call still means the
      // same page: mint the replacement, land it back on that page and run the action
      // there. Failing here would only make the model call `browser_open` and start over.
      if (attempt > 0) throw new Error(be("rebuildFailed"));
      target = await replace(error.tabId, error.url, request);
      recovery = be("retryRecovered");
    }
  }
  return withNote(outcome, [note, recovery].filter(Boolean).join("；") || undefined);
}

/**
 * Mint a fresh tab that resumes a page whose tab is gone, and make sure it can be
 * driven. Used both when the addressed tab was already known dead and when it died
 * under a request; both cases answer on the replacement rather than failing.
 */
async function replace(tabId: string, url: string, request: BrowserAutomationRequest): Promise<Entry> {
  if (registry.has(tabId)) retire(tabId);
  const paneId = paneConversationId(request.conversationId);
  const entry = ensureGuest(useSidePaneStore.getState().openBrowser(url, paneId), url);
  // `dom-ready` is the fresh document the src navigation produced, so the retry
  // injects into the resumed page rather than the one that is on its way out. A guest
  // that never gets there is dead too — this is the one failure worth reporting, since
  // a second tab that cannot start means the webview itself is not coming up.
  if (await usable(entry)) {
    rememberUrl(entry);
    return entry;
  }
  retire(entry.id);
  throw new Error(be("webviewOff"));
}

/** The actions that address an already-open tab. */
async function dispatch(request: BrowserAutomationRequest, entry: Entry): Promise<unknown> {
  const view = entry.view;
  switch (request.action) {
    case "navigate": {
      if (!request.url) throw new Error(be("needUrl"));
      const url = normalizeUrl(request.url);
      const outcome = await loadUrl(view, url);
      rememberUrl(entry);
      return { tabId: entry.id, url, ...outcome };
    }
    case "search": {
      if (!request.text && !request.url) throw new Error(be("needSearch"));
      const query = request.text || request.url || "";
      const url = normalizeUrl(query);
      const outcome = await loadUrl(view, url);
      rememberUrl(entry);
      return { tabId: entry.id, query, url, ...outcome };
    }
    case "back":
      if (!safe(() => view.canGoBack(), false)) return { ok: false, error: be("noBack") };
      { const navigated = waitForNavigation(view); view.goBack(); await navigated; }
      rememberUrl(entry);
      return { ok: true, url: entry.url };
    case "forward":
      if (!safe(() => view.canGoForward(), false)) return { ok: false, error: be("noForward") };
      { const navigated = waitForNavigation(view); view.goForward(); await navigated; }
      rememberUrl(entry);
      return { ok: true, url: entry.url };
    case "reload": {
      const outcome = await loadUrl(view, entry.url || BLANK_PAGE, 20_000);
      rememberUrl(entry);
      return { ok: outcome.loaded, url: entry.url, ...outcome };
    }
    case "snapshot": {
      const result = (await inject(entry, SNAPSHOT_BODY)) as Record<string, unknown>;
      rememberUrl(entry);
      return { tabId: entry.id, ...result };
    }
    case "click": {
      if (!request.selector && !request.ref && !request.text) throw new Error(be("needClick"));
      return act(entry, clickBody(request), { clicked: true, warning: be("clickNav") });
    }
    case "type": {
      if (!request.selector && !request.ref) throw new Error(be("needType"));
      return act(entry, typeBody(request), { filled: true, warning: be("typeNav") }, 300);
    }
    case "press":
      return act(entry, pressBody(request.key ?? "Enter"), { pressed: request.key ?? "Enter", warning: be("pressNav") });
    case "evaluate":
      if (!request.script) throw new Error(be("needScript"));
      return execute(entry, request.script);
    case "decision-eval":
    case "decision-click":
    case "decision-replace":
    case "decision-wheel":
    case "decision-wait-load":
      return decisionAction(request, entry);
    default:
      throw new Error(be("unknownAction", { action: request.action }));
  }
}

/**
 * The decision loop's control layer (docs/decision-layer.md §7.3): raw page scripts and
 * native input on the guest, the Electron counterpart of jev-ultrafast's CDP calls.
 *
 * Scripts run unwrapped — the ported observe/guard/target scripts return their own
 * values and `null` for "not now" — and Main bounds every call's time, because a script
 * on a document that navigates away never settles. Input goes through the guest's input
 * pipeline (`sendInputEvent` / `insertText`), so pages see a real click or keystrokes
 * rather than synthetic DOM events.
 */
async function decisionAction(request: BrowserAutomationRequest, entry: Entry): Promise<unknown> {
  const view = entry.view;
  switch (request.action) {
    case "decision-eval":
      if (!request.script) throw new Error(be("needScript"));
      return view.executeJavaScript(request.script);
    case "decision-click": {
      const x = Math.round(request.x ?? -1);
      const y = Math.round(request.y ?? -1);
      if (x < 0 || y < 0) throw new Error("decision-click needs a point");
      view.sendInputEvent({ type: "mouseMove", x, y });
      view.sendInputEvent({ type: "mouseDown", x, y, button: "left", clickCount: 1 });
      view.sendInputEvent({ type: "mouseUp", x, y, button: "left", clickCount: 1 });
      return true;
    }
    case "decision-replace": {
      // Input events are asynchronous: wait for the click to focus an editable element.
      // insertText with nothing editable focused can wedge the guest, so never call it blind.
      const editable = "(() => { const e = document.activeElement; return !!e && (e.isContentEditable || ((e.tagName === 'INPUT' || e.tagName === 'TEXTAREA') && !e.readOnly)); })()";
      let focused = false;
      for (let attempt = 0; attempt < 20 && !(focused = Boolean(await view.executeJavaScript(editable))); attempt++) {
        await new Promise((resolve) => window.setTimeout(resolve, 25));
      }
      if (!focused) throw new Error("The field did not take focus");
      const text = request.text ?? "";
      view.selectAll();
      await Promise.race([view.insertText(text), new Promise((resolve) => window.setTimeout(resolve, 1000))]);
      // Date/time inputs ignore inserted text; set their value the way a framework expects.
      return view.executeJavaScript(`(() => { const e = document.activeElement, text = ${JSON.stringify(text)};
        if (e && /^(date|time|datetime-local|month|week)$/.test(e.type) && e.value !== text) {
          Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(e, text);
          e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true }));
        }
        return e && 'value' in e ? e.value : e ? e.innerText : null; })()`);
    }
    case "decision-wheel": {
      const box = view.getBoundingClientRect();
      // Electron's wheel delta is the opposite sign of CDP's: negative scrolls down.
      view.sendInputEvent({ type: "mouseWheel", x: Math.round(box.width / 2), y: Math.round(box.height / 2), deltaX: 0, deltaY: -(request.delta ?? 560) });
      return true;
    }
    case "decision-wait-load": {
      const deadline = Date.now() + Math.min(request.timeoutMs ?? 10_000, 20_000);
      while (safe(() => view.isLoading(), false) && Date.now() < deadline) {
        await new Promise((resolve) => window.setTimeout(resolve, 50));
      }
      rememberUrl(entry);
      return { url: entry.url, title: safe(() => view.getTitle(), "") };
    }
    default:
      throw new Error(be("unknownAction", { action: request.action }));
  }
}

export function releaseBrowser(tabId: string): void {
  const entry = registry.get(tabId);
  if (!entry) return;
  registry.delete(tabId);
  // The layer must stop claiming a viewport on behalf of a tab that is gone.
  parkGuest(tabId);
  entry.view.remove();
  entry.host.remove();
}

export function SidePaneBrowser({
  tabId,
  url,
  visible,
}: {
  tabId: string;
  url: string;
  visible: boolean;
}): JSX.Element {
  const { t } = useTranslation("sidepane");
  const patchTab = useSidePaneStore((state) => state.patchTab);
  const box = useRef<HTMLDivElement>(null);
  const guest = useRef<Guest | null>(null);
  const initialUrl = useRef(url);
  const [draft, setDraft] = useState(url);
  const [canGoBack, setCanGoBack] = useState(false);
  const [canGoForward, setCanGoForward] = useState(false);
  const [loading, setLoading] = useState(false);
  const [profiles, setProfiles] = useState<BrowserProfileInfo[]>([]);
  const [importing, setImporting] = useState(false);
  const [viewport, setViewport] = useState<ViewportMode>("responsive");
  const [zoom, setZoom] = useState(1);
  const [picking, setPicking] = useState(false);
  const [finding, setFinding] = useState(false);
  const [findText, setFindText] = useState("");
  const [findCount, setFindCount] = useState<{ active: number; total: number } | null>(null);
  const findBox = useRef<HTMLFormElement>(null);
  const faviconRef = useRef<string | undefined>(undefined);
  const viewportRef = useRef<ViewportMode>("responsive");
  const defaultAgent = useRef<string | null>(null);
  const takePickRef = useRef<() => Promise<void>>(async () => undefined);
  viewportRef.current = viewport;

  function setFavicon(url: string | undefined): void {
    if (faviconRef.current === url) return;
    faviconRef.current = url;
    patchTab(tabId, { faviconUrl: url ?? null });
  }

  function sync(view: Guest): void {
    const href = safe(() => view.getURL(), "") || "about:blank";
    const title = safe(() => view.getTitle(), "");
    setDraft(href === "about:blank" ? "" : href);
    setCanGoBack(safe(() => view.canGoBack(), false));
    setCanGoForward(safe(() => view.canGoForward(), false));
    if (href !== "about:blank") {
      // The user's own address-bar navigation counts too: it is what a recovery
      // would have to resume.
      const entry = registry.get(tabId);
      if (entry) entry.url = href;
      patchTab(tabId, { url: href, title: title || href.replace(/^https?:\/\//, "") });
    }
  }

  useEffect(() => {
    const entry = ensureGuest(tabId, initialUrl.current);
    guest.current = entry.view;

    const view = entry.view;
    const onInPageNav = (): void => sync(view);
    const onNav = (): void => {
      setFavicon(undefined);
      sync(view);
    };
    const onFavicon = (event: Event): void => {
      const picked = pickFavicon((event as FaviconEvent).favicons);
      if (picked) setFavicon(picked);
    };
    const onStart = (): void => setLoading(true);
    const onStop = (): void => {
      setLoading(false);
      sync(view);
      if (!faviconRef.current) setFavicon(originFavicon(safe(() => view.getURL(), "")));
    };
    view.addEventListener("did-navigate", onNav);
    view.addEventListener("did-navigate-in-page", onInPageNav);
    view.addEventListener("page-title-updated", onInPageNav);
    view.addEventListener("page-favicon-updated", onFavicon);
    const onFound = (event: Event): void => {
      const detail = event as Event & { result?: { activeMatchOrdinal?: number; matches?: number } };
      const total = detail.result?.matches ?? 0;
      setFindCount(total > 0 ? { active: detail.result?.activeMatchOrdinal ?? 0, total } : null);
    };
    view.addEventListener("did-start-loading", onStart);
    view.addEventListener("did-stop-loading", onStop);
    view.addEventListener("found-in-page", onFound);
    sync(view);
    setZoom(safe(() => view.getZoomFactor(), 1));

    return () => {
      view.removeEventListener("did-navigate", onNav);
      view.removeEventListener("did-navigate-in-page", onInPageNav);
      view.removeEventListener("page-title-updated", onInPageNav);
      view.removeEventListener("page-favicon-updated", onFavicon);
      view.removeEventListener("did-start-loading", onStart);
      view.removeEventListener("did-stop-loading", onStop);
      view.removeEventListener("found-in-page", onFound);
    };
  }, [patchTab, tabId]);

  const collapsed = useSidePaneStore((state) => state.collapsed);

  /**
   * Put this guest's layer over the tab's viewport while it is the one on screen,
   * and park it otherwise. The guest itself is never moved (see `getLayer`).
   *
   * The pane clips a fixed-width frame rather than resizing it, so the viewport has
   * to be observed through that frame's clip: the observer watches the clipping
   * ancestor so the guest follows the collapse spring frame by frame.
   */
  useEffect(() => {
    const entry = registry.get(tabId);
    const mount = box.current;
    if (!visible || collapsed || !entry || !mount) {
      parkGuest(tabId);
      return;
    }
    const clip = clipAncestor(mount);
    const place = (): void => {
      const node = box.current;
      if (!node) return;
      const rect = visibleRect(node, clip);
      showGuest(entry, rect);
      // Read the preset live: this also runs from the resize observer, which must
      // not put back the size the pane had when the effect was set up.
      if (owner === tabId) placeDevice(entry, viewportRef.current, rect);
    };
    place();
    const observer = new ResizeObserver(place);
    observer.observe(mount);
    if (clip) observer.observe(clip);
    window.addEventListener("resize", place);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", place);
      parkGuest(tabId);
    };
    // `viewport` is a dependency on purpose, even though `place` reads it through
    // the ref: changing it has to lay the guest out again immediately, and the
    // resize observer will not fire for a change that does not move the pane.
  }, [collapsed, tabId, viewport, visible]);

  /** A device size has to look like that device to the page, not only be that wide. */
  useEffect(() => {
    if (!visible) return;
    void applyUserAgent(viewport);
  }, [tabId, viewport, visible]);

  function go(next = draft): void {
    const href = normalizeUrl(next);
    setDraft(href);
    guest.current?.loadURL(href);
  }

  function onSubmit(event: FormEvent): void {
    event.preventDefault();
    go();
  }

  async function loadProfiles(): Promise<void> {
    if (blockedRemotely(Ipc.browserListProfiles)) return;
    try {
      setProfiles(await window.fastvibe.browser.listProfiles());
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    }
  }

  async function importProfile(profile: BrowserProfileInfo): Promise<void> {
    if (blockedRemotely(Ipc.browserImportProfile)) return;
    setImporting(true);
    try {
      const result: BrowserImportResult = await window.fastvibe.browser.importProfile(profile);
      toast.success(t("browser.importDone", { browser: result.browser, profile: result.profile }), {
        description: result.message,
      });
      const stopped = guest.current ? waitForNavigation(guest.current, 4_000) : null;
      guest.current?.reload();
      if (stopped) await stopped;
    } catch (error) {
      toast.error(t("browser.importFailed"), {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setImporting(false);
    }
  }

  /**
   * A device preset has to look like that device to the page, not only be that wide:
   * sites that branch on the user agent never reach their mobile layout otherwise.
   * The desktop agent is whatever the guest booted with, remembered once.
   */
  async function applyUserAgent(mode: ViewportMode): Promise<void> {
    const view = guest.current;
    if (!view?.setUserAgent) return;
    if (!defaultAgent.current) defaultAgent.current = safe(() => view.getUserAgent(), "");
    const base = defaultAgent.current;
    if (!base) return;
    const mobile = mode !== "responsive";
    const next = mobile
      ? base.replace(/\(Macintosh;[^)]*\)/, "(iPhone; CPU iPhone OS 17_0 like Mac OS X)").replace("Safari/", "Mobile/15E148 Safari/")
      : base;
    if (safe(() => view.getUserAgent(), "") === next) return;
    view.setUserAgent(next);
    const href = safe(() => view.getURL(), "");
    if (href && href !== "about:blank") view.reload();
  }

  function changeZoom(next: number): void {
    const clamped = Math.min(2, Math.max(0.5, next));
    setZoom(clamped);
    guest.current?.setZoomFactor(clamped);
  }

  function stepZoom(direction: 1 | -1): void {
    const current = zoom;
    const target = direction > 0
      ? ZOOM_STEPS.find((step) => step > current + 0.01)
      : [...ZOOM_STEPS].reverse().find((step) => step < current - 0.01);
    changeZoom(target ?? current);
  }

  function runFind(text: string, again = false): void {
    const view = guest.current;
    if (!view?.findInPage) return;
    if (!text) {
      view.stopFindInPage?.("clearSelection");
      setFindCount(null);
      return;
    }
    view.findInPage(text, { forward: true, findNext: again });
  }

  function closeFind(): void {
    setFinding(false);
    setFindCount(null);
    guest.current?.stopFindInPage?.("clearSelection");
  }

  async function togglePick(): Promise<void> {
    const view = guest.current;
    if (!view) return;
    if (picking) {
      setPicking(false);
      await inject(registry.get(tabId) as Entry, PICK_READ_BODY).catch(() => undefined);
      return;
    }
    const href = safe(() => view.getURL(), "");
    if (!href || href === "about:blank") {
      toast.error(t("browser.pickNeedPage"));
      return;
    }
    const entry = registry.get(tabId);
    if (!entry) return;
    setPicking(true);
    try {
      await inject(entry, PICK_BODY);
    } catch (error) {
      setPicking(false);
      toast.error(t("browser.attachFailed"), {
        description: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /** Read whatever the page click stored and drop it into the composer's chips. */
  async function takePick(): Promise<void> {
    const entry = registry.get(tabId);
    if (!entry) return;
    setPicking(false);
    type Picked = { selector?: string; text?: string; html?: string; url?: string };
    let picked: Picked | null = null;
    try {
      picked = (await inject(entry, PICK_READ_BODY)) as Picked | null;
    } catch (error) {
      toast.error(t("browser.attachFailed"), {
        description: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    if (!picked?.selector && !picked?.text) return;
    const activeId = useSessionStore.getState().activeId;
    if (!activeId) {
      toast.error(t("browser.noConversation"));
      return;
    }
    const body = [
      picked.url ? `URL: ${picked.url}` : "",
      picked.selector ? `Selector: ${picked.selector}` : "",
      picked.text ? `\n${picked.text}` : "",
      picked.html && picked.html !== picked.text ? `\n\n${picked.html}` : "",
    ].filter(Boolean).join("\n");
    const name = (picked.selector || t("browser.pick")).slice(0, 48);
    const attachment: ChatAttachment = {
      id: crypto.randomUUID(),
      kind: "file",
      name,
      mimeType: "text/plain",
      text: body.slice(0, PICK_TEXT_LIMIT),
    };
    const { attachments, setAttachments } = useSessionStore.getState();
    setAttachments([...attachments, attachment]);
    toast.success(t("browser.attached"));
  }
  takePickRef.current = takePick;

  useEffect(() => {
    if (!picking) return;
    const timer = window.setInterval(() => {
      const entry = registry.get(tabId);
      if (!entry) return;
      void inject(entry, "return Boolean(window.__fvPicked)")
        .then((hit) => {
          if (hit) void takePickRef.current();
        })
        .catch(() => undefined);
    }, 250);
    return () => window.clearInterval(timer);
  }, [picking, tabId]);

  async function copyUrl(): Promise<void> {
    const href = safe(() => guest.current?.getURL() ?? "", "") || normalizeUrl(draft);
    if (!href || href === "about:blank") return;
    try {
      await navigator.clipboard.writeText(href);
      toast.success(t("browser.copiedUrl"));
    } catch {
      toast.error(t("browser.copyFailed"));
    }
  }

  async function clearData(): Promise<void> {
    if (blockedRemotely(Ipc.browserClearData)) return;
    if (!window.confirm(t("browser.clearConfirm"))) return;
    try {
      await window.fastvibe.browser.clearData();
      guest.current?.reload();
      toast.success(t("browser.cleared"));
    } catch (error) {
      toast.error(t("browser.clearFailed"), {
        description: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const viewportIcon = viewport === "mobile" ? SmartPhone01Icon : viewport === "tablet" ? Tablet01Icon : ComputerIcon;
  const viewportTitle = viewport === "responsive"
    ? `${t("browser.responsive")} · ${t("browser.responsiveSize")}`
    : `${t(`browser.${viewport}`)} · ${viewport === "mobile" ? "375 × 812" : "768 × 1024"}`;

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-background" aria-hidden={!visible}>
      <form className="relative flex h-12 items-center gap-1.5 px-3" onSubmit={onSubmit}>
        <Button type="button" size="icon-xs" variant="ghost" disabled={!canGoBack} title={t("browser.back")} onClick={() => guest.current?.goBack()}>
          <HugeiconsIcon strokeWidth={2} icon={ArrowLeft01Icon} />
        </Button>
        <Button type="button" size="icon-xs" variant="ghost" disabled={!canGoForward} title={t("browser.forward")} onClick={() => guest.current?.goForward()}>
          <HugeiconsIcon strokeWidth={2} icon={ArrowRight01Icon} />
        </Button>
        <Button type="button" size="icon-xs" variant="ghost" title={t("browser.reload")} onClick={() => guest.current?.reload()}>
          <HugeiconsIcon strokeWidth={2} icon={Refresh01Icon} className={loading ? "animate-spin" : undefined} />
        </Button>
        <Input
          value={draft}
          placeholder={t("browser.placeholder")}
          className="h-7 flex-1 rounded-lg text-xs"
          spellCheck={false}
          onChange={(event) => setDraft(event.target.value)}
        />
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button type="button" size="icon-xs" variant="ghost" title={viewportTitle} aria-label={viewportTitle}>
                <HugeiconsIcon strokeWidth={2} icon={viewportIcon} />
              </Button>
            }
          />
          <DropdownMenuContent align="end" className="min-w-56">
            <DropdownMenuGroup>
              <DropdownMenuLabel>{t("browser.viewport")}</DropdownMenuLabel>
              <DropdownMenuRadioGroup value={viewport} onValueChange={(value) => setViewport(value as ViewportMode)}>
                <DropdownMenuRadioItem value="responsive">
                  <HugeiconsIcon strokeWidth={2} icon={ComputerIcon} />
                  <span className="flex-1">{t("browser.responsive")}</span>
                  <span className="text-xs text-muted-foreground">{t("browser.responsiveSize")}</span>
                </DropdownMenuRadioItem>
                <DropdownMenuRadioItem value="mobile">
                  <HugeiconsIcon strokeWidth={2} icon={SmartPhone01Icon} />
                  <span className="flex-1">{t("browser.mobile")}</span>
                  <span className="text-xs text-muted-foreground">375 × 812</span>
                </DropdownMenuRadioItem>
                <DropdownMenuRadioItem value="tablet">
                  <HugeiconsIcon strokeWidth={2} icon={Tablet01Icon} />
                  <span className="flex-1">{t("browser.tablet")}</span>
                  <span className="text-xs text-muted-foreground">768 × 1024</span>
                </DropdownMenuRadioItem>
              </DropdownMenuRadioGroup>
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button type="button" size="icon-xs" variant="ghost" title={t("browser.more")}>
                <HugeiconsIcon strokeWidth={2} icon={MoreHorizontalIcon} />
                <span className="sr-only">{t("browser.more")}</span>
              </Button>
            }
          />
          <DropdownMenuContent align="end" className="min-w-56">
            <DropdownMenuGroup>
              <DropdownMenuItem onClick={() => void togglePick()}>
                <HugeiconsIcon strokeWidth={2} icon={picking ? Tick02Icon : CursorRectangleSelection01Icon} />
                {picking ? t("browser.pickCancel") : t("browser.pick")}
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() => {
                  setFinding(true);
                  window.setTimeout(() => findBox.current?.querySelector("input")?.focus(), 0);
                }}
              >
                <HugeiconsIcon strokeWidth={2} icon={Search01Icon} />
                {t("browser.find")}
              </DropdownMenuItem>
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              <DropdownMenuLabel>{t("browser.zoom")}</DropdownMenuLabel>
              <DropdownMenuItem onClick={() => stepZoom(1)}>
                <HugeiconsIcon strokeWidth={2} icon={ZoomInAreaIcon} />
                {t("browser.zoomIn")}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => stepZoom(-1)}>
                <HugeiconsIcon strokeWidth={2} icon={ZoomOutAreaIcon} />
                {t("browser.zoomOut")}
              </DropdownMenuItem>
              <DropdownMenuItem disabled={zoom === 1} onClick={() => changeZoom(1)}>
                {t("browser.zoomReset")}
                <span className="ml-auto text-xs text-muted-foreground">{t("browser.zoomLevel", { percent: Math.round(zoom * 100) })}</span>
              </DropdownMenuItem>
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <DropdownMenuSub>
              <DropdownMenuSubTrigger onMouseEnter={() => void loadProfiles()}>
                <HugeiconsIcon strokeWidth={2} icon={Upload01Icon} />
                {t("browser.importHeading")}
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="max-h-72 min-w-64">
                <DropdownMenuGroup>
                  <DropdownMenuLabel>{t("browser.importTitle")}</DropdownMenuLabel>
                  {profiles.length === 0 ? (
                    <DropdownMenuItem disabled>{t("browser.noProfiles")}</DropdownMenuItem>
                  ) : (
                    profiles.map((profile) => (
                      <DropdownMenuItem key={profile.id} disabled={importing} onClick={() => void importProfile(profile)}>
                        <span className="min-w-0 flex-1 truncate">{profile.browser} · {profile.name}</span>
                      </DropdownMenuItem>
                    ))
                  )}
                </DropdownMenuGroup>
              </DropdownMenuSubContent>
            </DropdownMenuSub>
            <DropdownMenuItem
              onClick={() => {
                const href = safe(() => guest.current?.getURL() ?? "", "") || normalizeUrl(draft);
                if (href && href !== "about:blank") window.open(href, "_blank");
              }}
            >
              <HugeiconsIcon strokeWidth={2} icon={LinkSquare02Icon} />
              {t("browser.openExternal")}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => void copyUrl()}>
              <HugeiconsIcon strokeWidth={2} icon={Copy01Icon} />
              {t("browser.copyUrl")}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onClick={() => void clearData()}>
              <HugeiconsIcon strokeWidth={2} icon={Delete02Icon} />
              {t("browser.clearData")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </form>
      {picking ? (
        <div className="truncate px-3 pb-1 text-xs text-muted-foreground">{t("browser.pickHint")}</div>
      ) : null}
      <div ref={box} className="relative min-h-0 min-w-0 flex-1 overflow-hidden bg-white">
        {!draft.trim() ? (
          <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center bg-background">
            <Empty className="flex-none border-0 py-6">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <HugeiconsIcon strokeWidth={2} icon={ChromeIcon} />
                </EmptyMedia>
                <EmptyTitle>{t("browser.emptyTitle")}</EmptyTitle>
                <EmptyDescription>{t("browser.emptyDescription")}</EmptyDescription>
              </EmptyHeader>
            </Empty>
          </div>
        ) : null}
      </div>
      {finding ? (
        <form
          ref={findBox}
          className="flex h-9 items-center gap-1 border-t border-border px-2"
          onSubmit={(event) => {
            event.preventDefault();
            runFind(findText, true);
          }}
        >
          <HugeiconsIcon strokeWidth={2} icon={Search01Icon} className="size-3.5 text-muted-foreground" />
          <Input
            value={findText}
            placeholder={t("browser.findPlaceholder")}
            className="h-6 flex-1 border-0 bg-transparent px-1 text-xs shadow-none focus-visible:ring-0"
            spellCheck={false}
            autoFocus
            onChange={(event) => {
              setFindText(event.target.value);
              runFind(event.target.value);
            }}
          />
          <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
            {findText && findCount ? t("browser.findCount", findCount) : findText ? t("browser.findEmpty") : ""}
          </span>
          <Button type="button" size="icon-xs" variant="ghost" title={t("browser.findPrev")} onClick={() => guest.current?.findInPage(findText, { forward: false, findNext: true })}>
            <HugeiconsIcon strokeWidth={2} icon={ArrowUp01Icon} />
          </Button>
          <Button type="submit" size="icon-xs" variant="ghost" title={t("browser.findNext")}>
            <HugeiconsIcon strokeWidth={2} icon={ArrowDown01Icon} />
          </Button>
          <Button type="button" size="icon-xs" variant="ghost" title={t("browser.findClose")} onClick={closeFind}>
            <HugeiconsIcon strokeWidth={2} icon={Delete02Icon} />
          </Button>
        </form>
      ) : null}
    </div>
  );
}
