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
import { useSidePaneStore } from "@/stores/side-pane";
import type { BrowserImportResult, BrowserProfileInfo } from "@shared/types";

export type BrowserAutomationRequest = {
  action: string;
  tabId?: string;
  url?: string;
  selector?: string;
  text?: string;
  key?: string;
  script?: string;
};

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
  host: HTMLDivElement;
  view: Guest;
  /** The guest cannot executeJavaScript until its first dom-ready event. */
  ready: Promise<void>;
};

const registry = new Map<string, Entry>();
let stash: HTMLDivElement | null = null;

function getStash(): HTMLDivElement {
  if (!stash) {
    stash = document.createElement("div");
    stash.setAttribute("data-side-pane-browser-stash", "");
    stash.style.display = "none";
    document.body.appendChild(stash);
  }
  return stash;
}

const SEARCH_ENGINE = "https://www.google.com/search?q=";

function normalizeUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "https://fastvibe.dev";
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

function entryFor(tabId?: string): Entry | undefined {
  if (tabId) return registry.get(tabId);
  return registry.values().next().value as Entry | undefined;
}

function waitForEntry(tabId: string, timeout = 5_000): Promise<Entry> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = (): void => {
      const entry = registry.get(tabId);
      if (entry) return resolve(entry);
      if (Date.now() - started >= timeout) return reject(new Error("浏览器标签页尚未准备好"));
      window.setTimeout(tick, 50);
    };
    tick();
  });
}

async function execute(entry: Entry, code: string): Promise<unknown> {
  if (typeof entry.view.executeJavaScript !== "function") throw new Error("当前 Electron 不支持网页脚本执行");
  return entry.view.executeJavaScript(code);
}

function waitForStop(view: Guest, timeout = 15_000): Promise<void> {
  return new Promise((resolve) => {
    let timer: number | undefined;
    const done = (): void => {
      if (timer !== undefined) window.clearTimeout(timer);
      view.removeEventListener("did-stop-loading", done);
      resolve();
    };
    view.addEventListener("did-stop-loading", done);
    timer = window.setTimeout(done, timeout);
  });
}

async function waitForReady(entry: Entry, timeout = 15_000): Promise<void> {
  let timer: number | undefined;
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

/** Handle browser-use requests arriving from the main-process extension tool. */
export async function handleBrowserRequest(request: BrowserAutomationRequest): Promise<unknown> {
  if (request.action === "open") {
    const tabId = useSidePaneStore.getState().openBrowser(request.url);
    const entry = await waitForEntry(tabId);
    await waitForReady(entry);
    return { tabId };
  }
  if (request.action === "list") {
    return [...registry.entries()].map(([tabId, entry]) => ({ tabId, url: safe(() => entry.view.getURL(), ""), title: safe(() => entry.view.getTitle(), "") }));
  }
  const entry = entryFor(request.tabId);
  if (!entry) throw new Error("没有可用的浏览器标签页，请先调用 browser_open");
  // GUEST_VIEW_MANAGER_CALL rejects calls made before the guest has reached
  // dom-ready. This also covers a tool call issued immediately after opening
  // a tab, before React has observed the first navigation event.
  await waitForReady(entry);
  const view = entry.view;
  switch (request.action) {
    case "navigate": {
      if (!request.url) throw new Error("navigate 需要 url");
      const stopped = waitForStop(view);
      view.loadURL(normalizeUrl(request.url));
      await stopped;
      return { tabId: request.tabId, url: normalizeUrl(request.url) };
    }
    case "search": {
      if (!request.text && !request.url) throw new Error("search 需要 text");
      const query = request.text || request.url || "";
      const stopped = waitForStop(view);
      view.loadURL(normalizeUrl(query));
      await stopped;
      return { tabId: request.tabId, query, url: normalizeUrl(query) };
    }
    case "back":
      { const stopped = waitForStop(view); view.goBack(); await stopped; }
      return { ok: true };
    case "forward":
      { const stopped = waitForStop(view); view.goForward(); await stopped; }
      return { ok: true };
    case "reload": {
      const stopped = waitForStop(view);
      view.reload();
      await stopped;
      return { ok: true };
    }
    case "snapshot":
      return execute(entry, `(() => {
        const visible = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
        const nodes = [...document.querySelectorAll('a,button,input,textarea,select,[role="button"],[role="link"]')].filter(visible).slice(0, 160);
        return { url: location.href, title: document.title, text: (document.body?.innerText || '').slice(0, 12000), elements: nodes.map((el, index) => ({ index, tag: el.tagName.toLowerCase(), role: el.getAttribute('role'), text: (el.innerText || el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.value || '').trim().slice(0, 240), href: el.href || undefined, selector: el.id ? '#' + CSS.escape(el.id) : undefined }))); 
      })()`);
    case "click": {
      if (!request.selector && !request.text) throw new Error("click 需要 selector 或 text");
      const selector = JSON.stringify(request.selector ?? "");
      const text = JSON.stringify(request.text ?? "");
      const result = await execute(entry, `(() => { const selector = ${selector}; const text = ${text}; const candidates = selector ? [document.querySelector(selector)] : [...document.querySelectorAll('button,a,[role="button"],[role="link"]')]; const el = candidates.find((item) => item && (visible(item) || item === candidates[0]) && (!text || (item.innerText || item.getAttribute('aria-label') || '').trim().includes(text))); if (!el) return { ok: false, error: '元素未找到' }; el.click(); return { ok: true, text: (el.innerText || el.getAttribute('aria-label') || '').trim().slice(0, 240) }; function visible(item) { const r = item.getBoundingClientRect(); return r.width > 0 && r.height > 0; } })()`);
      await new Promise((resolve) => window.setTimeout(resolve, 100));
      return result;
    }
    case "type": {
      if (!request.selector) throw new Error("type 需要 selector");
      const selector = JSON.stringify(request.selector);
      const text = JSON.stringify(request.text ?? "");
      return execute(entry, `(() => { const el = document.querySelector(${selector}); if (!el) return { ok: false, error: '元素未找到' }; el.focus(); const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value')?.set; if (setter) setter.call(el, ${text}); else el.value = ${text}; el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: ${text} })); el.dispatchEvent(new Event('change', { bubbles: true })); return { ok: true }; })()`);
    }
    case "press": {
      const key = JSON.stringify(request.key ?? "Enter");
      return execute(entry, `(() => { const target = document.activeElement || document.body; const key = ${key}; target.dispatchEvent(new KeyboardEvent('keydown', { key, code: key, bubbles: true })); target.dispatchEvent(new KeyboardEvent('keyup', { key, code: key, bubbles: true })); return { ok: true, key }; })()`);
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
      patchTab(tabId, { url: href, title: title || href.replace(/^https?:\/\//, "") });
    }
  }

  useEffect(() => {
    const mount = box.current;
    if (!mount) return;
    let entry = registry.get(tabId);
    if (!entry) {
      const host = document.createElement("div");
      host.className = "h-full min-h-0 w-full";
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
      entry = { host, view, ready };
      registry.set(tabId, entry);
      // Mount the guest before assigning src. A detached <webview> can accept
      // the property but never creates a guest, which later makes every
      // GUEST_VIEW_MANAGER_CALL fail and leaves the registry without a usable tab.
      mount.appendChild(host);
      view.src = normalizeUrl(initialUrl.current);
    }
    guest.current = entry.view;
    if (entry.host.parentElement !== mount) mount.appendChild(entry.host);

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
      if (entry && entry.host.parentElement === mount) getStash().appendChild(entry.host);
    };
  }, [patchTab, tabId]);

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
      const stopped = guest.current ? waitForStop(guest.current) : null;
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
