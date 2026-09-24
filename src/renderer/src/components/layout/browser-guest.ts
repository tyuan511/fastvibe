import { i18n } from "@/lib/i18n";
import { useSessionStore } from "@/stores/session";
import { useSidePaneStore } from "@/stores/side-pane";
import { clickBody, pageProgram, pressBody, SNAPSHOT_BODY, typeBody } from "@shared/browser-page";
import type { BrowserRequest } from "@shared/types";

function be(key: string, options?: Record<string, unknown>): string {
  return i18n.t(`sidepane:browser.${key}`, options) as string;
}

/** Retained as the renderer-side name for the shared browser-use protocol. */
export type BrowserAutomationRequest = BrowserRequest;

export type Guest = HTMLElement & {
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

export type FaviconEvent = Event & { favicons?: string[] };

export function pickFavicon(urls: string[] | undefined): string | undefined {
  return urls?.find((href) => /^(https?:|data:)/i.test(href));
}

export function originFavicon(href: string): string | undefined {
  try {
    const parsed = new URL(href);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined;
    return `${parsed.origin}/favicon.ico`;
  } catch {
    return undefined;
  }
}

export type Entry = {
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

export const registry = new Map<string, Entry>();

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
export let owner: string | null = null;

const PARKED_LAYER =
  "position:fixed;left:-10000px;top:0;width:1024px;height:768px;overflow:hidden;pointer-events:none;z-index:5;";
const SHOWN_HOST = "position:absolute;left:0;top:0;width:100%;height:100%;";
const HIDDEN_HOST = "position:absolute;left:-20000px;top:0;width:1024px;height:768px;";

/**
 * Viewport presets the bottom bar offers. Responsive is the pane itself at 100%;
 * the two devices are CSS pixels, matching Chrome's device mode, and the page is
 * laid out at that width while the pane stays whatever size the user dragged it to.
 */
export type ViewportMode = "responsive" | "mobile" | "tablet";
const VIEWPORTS: Record<Exclude<ViewportMode, "responsive">, { width: number; height: number }> = {
  mobile: { width: 375, height: 812 },
  tablet: { width: 768, height: 1024 },
};
export const ZOOM_STEPS = [0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2];
/** How much of a picked element's text rides along as the chip's readable content. */
export const PICK_TEXT_LIMIT = 8_000;

export const PICK_BODY = `
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

export const PICK_READ_BODY = `
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
export function clipAncestor(node: HTMLElement): HTMLElement | null {
  for (let el = node.parentElement; el; el = el.parentElement) {
    const style = getComputedStyle(el);
    if (style.overflowX === "hidden" || style.overflowY === "hidden") return el;
  }
  return null;
}

/** The part of the browser viewport actually on screen. */
export function visibleRect(
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
export function showGuest(entry: Entry, rect: { left: number; top: number; width: number; height: number }): void {
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
export function placeDevice(entry: Entry, mode: ViewportMode, box: { width: number; height: number }): void {
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
export function parkGuest(tabId: string): void {
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

export function ensureGuest(tabId: string, url: string): Entry {
  return registry.get(tabId) ?? createGuest(tabId, url);
}

const SEARCH_ENGINE = "https://www.google.com/search?q=";

/** What an address-less tab loads: an empty page, never a site the app picked. */
const BLANK_PAGE = "about:blank";

export function normalizeUrl(value: string): string {
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

export function safe<T>(read: () => T, fallback: T): T {
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
export async function inject(entry: Entry, body: string): Promise<unknown> {
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
export function waitForNavigation(view: Guest, grace = 500, timeout = 20_000): Promise<boolean> {
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
