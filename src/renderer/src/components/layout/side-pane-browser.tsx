import { useEffect, useRef, useState, type FormEvent, type JSX } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  ArrowLeft01Icon,
  ArrowRight01Icon,
  LinkSquare02Icon,
  Refresh01Icon,
  Upload01Icon,
} from "@hugeicons/core-free-icons";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useSessionStore } from "@/stores/session";
import { useSidePaneStore } from "@/stores/side-pane";
import type { BrowserImportResult, BrowserProfileInfo, BrowserRequest } from "@shared/types";

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
/** The pane's splitter (`w-1`) hugs its leading edge; leave it clickable. */
const SPLITTER_GUTTER = 4;

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

/** The part of the browser viewport actually on screen, splitter left alone. */
function visibleRect(
  node: HTMLElement,
  clip: HTMLElement | null,
): { left: number; top: number; width: number; height: number } {
  const box = node.getBoundingClientRect();
  let left = box.left + SPLITTER_GUTTER;
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
  if (ids.length === 0) throw new Error("内置浏览器还没有打开任何标签页，请先调用 browser_open");
  if (!tabId) return { entry: registry.get(ids[ids.length - 1]) as Entry, note: "未指定 tabId，已使用最近打开的标签页" };
  if (ids.length === 1) return { entry: registry.get(ids[0]) as Entry, note: `标签页 ${tabId} 已不存在，已在当前唯一的标签页上执行` };
  throw new Error(`标签页 ${tabId} 不存在（当前可用：${ids.join("、")}），请用 browser_list_tabs 确认后重试`);
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
  return new TabGoneError(entry.id, url, "浏览器标签页已失效");
}

async function execute(entry: Entry, code: string): Promise<unknown> {
  if (typeof entry.view.executeJavaScript !== "function") throw new Error("当前 Electron 不支持网页脚本执行");
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
        throw new Error("浏览器页面脚本执行失败（页面可能正在跳转），请重新调用 browser_snapshot 确认页面状态");
      }
      throw gone(entry);
    }
    if (/GUEST_VIEW_MANAGER_CALL|destroyed|was disposed|Render frame/i.test(message)) {
      throw gone(entry);
    }
    throw new Error(`浏览器脚本执行失败：${message}`);
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
  const code = `(() => { try { const value = (() => { ${body} })(); return { ok: true, value: JSON.parse(JSON.stringify(value === undefined ? null : value)) }; } catch (error) { return { ok: false, error: String((error && error.message) || error) }; } })()`;
  const result = (await execute(entry, code)) as Injected | undefined;
  if (!result || typeof result !== "object") throw new Error("浏览器页面返回了无效结果，请重试");
  if (!result.ok) throw new Error(`浏览器操作失败：${result.error ?? "页面脚本报错"}`);
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
      failure = `${detail.errorDescription ?? "页面加载失败"}（${detail.errorCode ?? "?"}）`;
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
        timer = window.setTimeout(() => reject(new Error("浏览器页面在等待 dom-ready 时超时")), timeout);
      }),
    ]);
  } finally {
    if (timer !== undefined) window.clearTimeout(timer);
  }
}

const SNAPSHOT_ELEMENT_LIMIT = 150;
const SNAPSHOT_TEXT_LIMIT = 8_000;

/**
 * In-page helpers shared by the click / type scripts. An element is addressed by
 * `ref` (stamped by the last snapshot), then by `selector` (also from the snapshot),
 * then by visible text. A miss lists the labels that were on offer, so the model can
 * retry without another round trip.
 */
const PAGE_HELPERS = `
  const visible = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 1 && r.height > 1 && s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity) > 0.05; };
  const clean = (value) => String(value == null ? '' : value).replace(/\\s+/g, ' ').trim();
  const label = (el) => clean(el.innerText || el.value || el.getAttribute('aria-label') || el.getAttribute('title') || el.getAttribute('placeholder') || el.getAttribute('name') || '');
  const TARGETS = 'a,button,summary,label,[role="button"],[role="link"],[role="tab"],[role="menuitem"],[role="option"],[role="checkbox"],[role="switch"],[contenteditable="true"],input:not([type="hidden"]),textarea,select';
  const resolve = () => {
    if (ref) { const hit = document.querySelector('[data-fv-ref="' + ref + '"]'); if (hit) return hit; }
    if (selector) { try { const hit = document.querySelector(selector); if (hit) return hit; } catch (error) { throw new Error('selector 无效：' + selector); } }
    const needle = clean(text).toLowerCase();
    if (!needle) return null;
    const pool = [...document.querySelectorAll(TARGETS)].filter(visible);
    return pool.find((el) => label(el).toLowerCase() === needle)
      || pool.find((el) => label(el).toLowerCase().startsWith(needle))
      || pool.find((el) => label(el).toLowerCase().includes(needle))
      || null;
  };
  const nearby = () => [...document.querySelectorAll(TARGETS)].filter(visible).map(label).filter(Boolean).slice(0, 12);
`;

/**
 * The snapshot. Elements carry a `ref` (stamped as `data-fv-ref`, so a click can
 * address the exact element even after the page mutates) and a `selector` (an `#id`
 * or a short `nth-of-type` path), and a miss is data, never a throw.
 */
const SNAPSHOT_BODY = `
  const visible = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 1 && r.height > 1 && s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity) > 0.05; };
  const clean = (value) => String(value == null ? '' : value).replace(/\\s+/g, ' ').trim();
  const path = (el) => {
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && node !== document.body && parts.length < 6) {
      let part = node.tagName.toLowerCase();
      const parent = node.parentElement;
      if (parent) {
        const same = [...parent.children].filter((child) => child.tagName === node.tagName);
        if (same.length > 1) part += ':nth-of-type(' + (same.indexOf(node) + 1) + ')';
      }
      parts.unshift(part);
      node = parent;
    }
    return parts.length ? 'body > ' + parts.join(' > ') : 'body';
  };
  const TARGETS = 'a,button,summary,label,[role="button"],[role="link"],[role="tab"],[role="menuitem"],[role="option"],[role="checkbox"],[role="switch"],[contenteditable="true"],input:not([type="hidden"]),textarea,select';
  const all = [...document.querySelectorAll(TARGETS)].filter(visible);
  const elements = all.slice(0, ${SNAPSHOT_ELEMENT_LIMIT}).map((el, index) => {
    const ref = 'e' + index;
    try { el.setAttribute('data-fv-ref', ref); } catch (error) { void error; }
    const tag = el.tagName.toLowerCase();
    return {
      ref,
      tag,
      type: el.getAttribute('type') || undefined,
      role: el.getAttribute('role') || undefined,
      text: clean(el.innerText || el.value || el.getAttribute('aria-label') || el.getAttribute('title') || el.getAttribute('placeholder') || el.getAttribute('name') || '').slice(0, 200),
      name: el.getAttribute('name') || undefined,
      href: tag === 'a' ? el.href : undefined,
      disabled: el.disabled === true ? true : undefined,
      selector: el.id ? '#' + CSS.escape(el.id) : path(el),
    };
  });
  return {
    url: location.href,
    title: document.title,
    elementCount: all.length,
    truncated: all.length > elements.length,
    elements,
    text: (document.body ? document.body.innerText : '').replace(/\\n{3,}/g, '\\n\\n').slice(0, ${SNAPSHOT_TEXT_LIMIT}),
  };
`;

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
  if (!entry) throw new Error("内置浏览器无法创建可用的标签页，请稍后重试");
  const note = replaced ? "原标签页已失效，已自动打开一个可用标签页" : undefined;
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
    recovery = "原标签页已失效，已自动在新标签页中恢复该页面";
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
      if (attempt > 0) throw new Error("内置浏览器标签页反复失效，自动重建后仍未成功，请稍后重试");
      target = await replace(error.tabId, error.url, request);
      recovery = "原标签页已失效，已自动在新标签页中恢复该页面并重试";
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
  throw new Error("内置浏览器无法创建可用的标签页（当前 Electron 的 webview 可能未启用），请稍后重试");
}

/** The actions that address an already-open tab. */
async function dispatch(request: BrowserAutomationRequest, entry: Entry): Promise<unknown> {
  const view = entry.view;
  switch (request.action) {
    case "navigate": {
      if (!request.url) throw new Error("navigate 需要 url");
      const url = normalizeUrl(request.url);
      const outcome = await loadUrl(view, url);
      rememberUrl(entry);
      return { tabId: entry.id, url, ...outcome };
    }
    case "search": {
      if (!request.text && !request.url) throw new Error("search 需要 text");
      const query = request.text || request.url || "";
      const url = normalizeUrl(query);
      const outcome = await loadUrl(view, url);
      rememberUrl(entry);
      return { tabId: entry.id, query, url, ...outcome };
    }
    case "back":
      if (!safe(() => view.canGoBack(), false)) return { ok: false, error: "没有可后退的历史记录" };
      { const navigated = waitForNavigation(view); view.goBack(); await navigated; }
      rememberUrl(entry);
      return { ok: true, url: entry.url };
    case "forward":
      if (!safe(() => view.canGoForward(), false)) return { ok: false, error: "没有可前进的历史记录" };
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
      if (!request.selector && !request.ref && !request.text) throw new Error("click 需要 selector、ref 或 text");
      return act(
        entry,
        `
        const selector = ${JSON.stringify(request.selector ?? "")};
        const ref = ${JSON.stringify(request.ref ?? "")};
        const text = ${JSON.stringify(request.text ?? "")};
        ${PAGE_HELPERS}
        const el = resolve();
        if (!el) return { clicked: false, error: '未找到可点击的元素', candidates: nearby() };
        el.scrollIntoView({ block: 'center', inline: 'center' });
        if (el.focus) el.focus();
        for (const type of ['pointerover', 'mouseover', 'pointerdown', 'mousedown', 'pointerup', 'mouseup']) {
          const ctor = type.indexOf('pointer') === 0 ? window.PointerEvent : MouseEvent;
          el.dispatchEvent(new ctor(type, { bubbles: true, cancelable: true, view: window, detail: 1 }));
        }
        el.click();
        return { clicked: true, tag: el.tagName.toLowerCase(), text: label(el).slice(0, 200), href: el.tagName === 'A' ? el.getAttribute('href') || undefined : undefined };
      `,
        { clicked: true, warning: "点击后页面开始加载，未能取回点击结果" },
      );
    }
    case "type": {
      if (!request.selector && !request.ref) throw new Error("type 需要 selector 或 ref");
      return act(
        entry,
        `
        const selector = ${JSON.stringify(request.selector ?? "")};
        const ref = ${JSON.stringify(request.ref ?? "")};
        const text = ${JSON.stringify(request.text ?? "")};
        ${PAGE_HELPERS}
        const el = resolve();
        if (!el) return { filled: false, error: '未找到输入元素', candidates: nearby() };
        el.scrollIntoView({ block: 'center' });
        el.focus();
        const value = text;
        if (el.tagName === 'SELECT') {
          const wanted = clean(value).toLowerCase();
          const options = [...el.options];
          const option = options.find((item) => item.value.toLowerCase() === wanted || clean(item.text).toLowerCase() === wanted) || options.find((item) => clean(item.text).toLowerCase().includes(wanted));
          if (!option) return { filled: false, error: 'select 中没有匹配的选项', options: options.slice(0, 30).map((item) => ({ value: item.value, text: clean(item.text) })) };
          el.value = option.value;
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
          return { filled: true, tag: 'select', value: el.value };
        }
        if (el.type === 'checkbox' || el.type === 'radio') {
          const next = !/^(false|0|no|off|否|取消)$/i.test(clean(value));
          if (el.checked !== next) {
            el.checked = next;
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
          }
          return { filled: true, tag: el.tagName.toLowerCase(), checked: el.checked };
        }
        if (el.isContentEditable) {
          el.textContent = value;
          el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
          return { filled: true, tag: 'contenteditable', value: el.textContent };
        }
        if (!('value' in el)) return { filled: false, error: '该元素不接受文本输入（' + el.tagName.toLowerCase() + '）' };
        const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
        if (setter) setter.call(el, value); else el.value = value;
        el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return { filled: true, tag: el.tagName.toLowerCase(), value: el.value };
      `,
        { filled: true, warning: "输入后页面开始加载，未能取回输入结果" },
        300,
      );
    }
    case "press": {
      const key = JSON.stringify(request.key ?? "Enter");
      return act(
        entry,
        `
        const key = ${key};
        const target = document.activeElement || document.body;
        const LEGACY = { Enter: 13, Tab: 9, Escape: 27, Backspace: 8, Delete: 46, ArrowUp: 38, ArrowDown: 40, ArrowLeft: 37, ArrowRight: 39, ' ': 32, PageUp: 33, PageDown: 34, Home: 36, End: 35 };
        const keyCode = LEGACY[key] || (key.length === 1 ? key.toUpperCase().charCodeAt(0) : 0);
        const options = { key, code: key === ' ' ? 'Space' : key, keyCode, which: keyCode, bubbles: true, cancelable: true };
        for (const type of ['keydown', 'keypress', 'keyup']) target.dispatchEvent(new KeyboardEvent(type, options));
        return { pressed: key, target: target.tagName.toLowerCase() };
      `,
        { pressed: request.key ?? "Enter", warning: "按键后页面开始加载，未能取回按键结果" },
      );
    }
    case "evaluate":
      if (!request.script) throw new Error("evaluate 需要 script");
      return execute(entry, request.script);
    default:
      throw new Error(`未知浏览器操作：${request.action}`);
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
  const patchTab = useSidePaneStore((state) => state.patchTab);
  const box = useRef<HTMLDivElement>(null);
  const guest = useRef<Guest | null>(null);
  const initialUrl = useRef(url);
  const [draft, setDraft] = useState(url);
  const [canGoBack, setCanGoBack] = useState(false);
  const [canGoForward, setCanGoForward] = useState(false);
  const [loading, setLoading] = useState(false);
  const [profiles, setProfiles] = useState<BrowserProfileInfo[]>([]);
  const [showImport, setShowImport] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importStatus, setImportStatus] = useState<string | null>(null);
  const faviconRef = useRef<string | undefined>(undefined);

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
    view.addEventListener("did-start-loading", onStart);
    view.addEventListener("did-stop-loading", onStop);
    sync(view);

    return () => {
      view.removeEventListener("did-navigate", onNav);
      view.removeEventListener("did-navigate-in-page", onInPageNav);
      view.removeEventListener("page-title-updated", onInPageNav);
      view.removeEventListener("page-favicon-updated", onFavicon);
      view.removeEventListener("did-start-loading", onStart);
      view.removeEventListener("did-stop-loading", onStop);
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
      if (node) showGuest(entry, visibleRect(node, clip));
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
  }, [collapsed, tabId, visible]);

  function go(next = draft): void {
    const href = normalizeUrl(next);
    setDraft(href);
    guest.current?.loadURL(href);
  }

  function onSubmit(event: FormEvent): void {
    event.preventDefault();
    go();
  }

  async function openImportMenu(): Promise<void> {
    setImportStatus(null);
    try {
      setProfiles(await window.fastvibe.browser.listProfiles());
      setShowImport(true);
    } catch (error) {
      setImportStatus(error instanceof Error ? error.message : String(error));
    }
  }

  async function importProfile(profile: BrowserProfileInfo): Promise<void> {
    setImporting(true);
    setImportStatus(null);
    try {
      const result: BrowserImportResult = await window.fastvibe.browser.importProfile(profile);
      setImportStatus(result.message);
      setShowImport(false);
      const stopped = guest.current ? waitForNavigation(guest.current, 4_000) : null;
      guest.current?.reload();
      if (stopped) await stopped;
    } catch (error) {
      setImportStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setImporting(false);
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-background" aria-hidden={!visible}>
      <form className="relative flex h-12 items-center gap-2 px-3" onSubmit={onSubmit}>
        <Button type="button" size="icon-xs" variant="ghost" disabled={!canGoBack} title="后退" onClick={() => guest.current?.goBack()}>
          <HugeiconsIcon strokeWidth={2} icon={ArrowLeft01Icon} />
        </Button>
        <Button type="button" size="icon-xs" variant="ghost" disabled={!canGoForward} title="前进" onClick={() => guest.current?.goForward()}>
          <HugeiconsIcon strokeWidth={2} icon={ArrowRight01Icon} />
        </Button>
        <Button type="button" size="icon-xs" variant="ghost" title="刷新" onClick={() => guest.current?.reload()}>
          <HugeiconsIcon strokeWidth={2} icon={Refresh01Icon} className={loading ? "animate-spin" : undefined} />
        </Button>
        <Input
          value={draft}
          placeholder="输入网址或搜索内容后回车"
          className="h-7 flex-1 rounded-lg text-xs"
          spellCheck={false}
          onChange={(event) => setDraft(event.target.value)}
        />
        <Button
          type="button"
          size="icon-xs"
          variant="ghost"
          title="在默认浏览器中打开"
          onClick={() => {
            const href = safe(() => guest.current?.getURL() ?? "", "") || normalizeUrl(draft);
            if (href && href !== "about:blank") window.open(href, "_blank");
          }}
        >
          <HugeiconsIcon strokeWidth={2} icon={LinkSquare02Icon} />
        </Button>
        <Button type="button" size="icon-xs" variant="ghost" title="导入其他浏览器登录态" onClick={() => void openImportMenu()}>
          <HugeiconsIcon strokeWidth={2} icon={Upload01Icon} />
        </Button>
        {showImport ? (
          <div className="absolute right-3 top-10 z-30 w-72 rounded-xl border border-border bg-popover p-2 text-popover-foreground shadow-xl">
            <div className="px-2 pb-2 text-xs font-medium text-muted-foreground">导入浏览器登录态</div>
            {profiles.length === 0 ? <div className="px-2 py-3 text-xs text-muted-foreground">没有找到可导入的 Chromium 配置文件</div> : null}
            {profiles.map((profile) => (
              <button key={profile.id} type="button" disabled={importing} className="flex w-full items-center rounded-lg px-2 py-2 text-left text-xs hover:bg-accent disabled:opacity-50" onClick={() => void importProfile(profile)}>
                <span className="min-w-0 flex-1 truncate">{profile.browser} · {profile.name}</span>
                <span className="ml-2 text-muted-foreground">Cookie</span>
              </button>
            ))}
            <button type="button" className="mt-1 w-full rounded-lg px-2 py-1.5 text-left text-xs text-muted-foreground hover:bg-accent" onClick={() => setShowImport(false)}>取消</button>
          </div>
        ) : null}
        {importStatus ? <span className="absolute right-3 top-11 z-20 max-w-72 truncate rounded bg-muted px-2 py-1 text-xs text-muted-foreground">{importStatus}</span> : null}
      </form>
      <div ref={box} className="relative min-h-0 min-w-0 flex-1 overflow-hidden bg-white" />
    </div>
  );
}
