import { useEffect, useRef, useState, type FormEvent, type JSX } from "react";
import { useNavigate } from "react-router";
import { browserShortcut, nextBrowserZoom, type BrowserLibrary, type BrowserShortcut } from "@shared/browser-workspace";
import { BrowserClearDialog, BrowserHistoryDialog } from "./browser-library-dialog";
import { BrowserDownloadsPopover } from "./browser-downloads-popover";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  Camera01Icon, Cancel01Icon, Clock01Icon, Download01Icon, PrinterIcon, Settings01Icon,
  MinusSignIcon, PlusSignIcon, RotateRight01Icon,
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
  Upload01Icon,
} from "@hugeicons/core-free-icons";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/icon-button";
import { randomUUID } from "../../../../shared/random.ts";
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
import { useSessionStore } from "@/stores/session";
import { useSidePaneStore } from "@/stores/side-pane";
import type { BrowserImportResult, BrowserProfileInfo, ChatAttachment } from "@shared/types";
import {
  type Entry,
  type FaviconEvent,
  type Guest,
  PICK_BODY,
  PICK_READ_BODY,
  PICK_TEXT_LIMIT,
  type ViewportMode,
  clipAncestors,
  ensureGuest,
  inject,
  normalizeUrl,
  originFavicon,
  owner,
  parkGuest,
  pickFavicon,
  placeDevice,
  registry,
  safe,
  showGuest,
  visibleRect,
  waitForNavigation,
} from "./browser-guest";
export { handleBrowserRequest, releaseBrowser } from "./browser-guest";
export type { BrowserAutomationRequest } from "./browser-guest";

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
  const navigate = useNavigate();
  const patchTab = useSidePaneStore((state) => state.patchTab);
  const root = useRef<HTMLDivElement>(null);
  const address = useRef<HTMLInputElement>(null);
  const shortcutRef = useRef<(command: BrowserShortcut) => void>(() => undefined);
  const userAgentRef = useRef<() => void>(() => undefined);
  const [library, setLibrary] = useState<BrowserLibrary | null>(null);
  const [libraryError, setLibraryError] = useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [downloadsOpen, setDownloadsOpen] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [capturing, setCapturing] = useState(false);
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [pageUrl, setPageUrl] = useState(url);
  const [landscape, setLandscape] = useState(registry.get(tabId)?.landscape ?? false);
  const landscapeRef = useRef(landscape);
  landscapeRef.current = landscape;
  const box = useRef<HTMLDivElement>(null);
  const guest = useRef<Guest | null>(null);
  const initialUrl = useRef(url);
  const [draft, setDraft] = useState(url);
  const [canGoBack, setCanGoBack] = useState(false);
  const [canGoForward, setCanGoForward] = useState(false);
  const [loading, setLoading] = useState(false);
  const [profiles, setProfiles] = useState<BrowserProfileInfo[]>([]);
  const [importing, setImporting] = useState(false);
  const [viewport, setViewport] = useState<ViewportMode>(registry.get(tabId)?.viewport ?? "responsive");
  const [zoom, setZoom] = useState(1);
  const [picking, setPicking] = useState(false);
  const [finding, setFinding] = useState(false);
  const [findText, setFindText] = useState("");
  const [findCount, setFindCount] = useState<{ active: number; total: number } | null>(null);
  const findBox = useRef<HTMLFormElement>(null);
  const faviconRef = useRef<string | undefined>(undefined);
  const viewportRef = useRef<ViewportMode>("responsive");
  const defaultAgent = useRef<string | null>(registry.get(tabId)?.originalUserAgent ?? null);
  const findRequest = useRef<number | null>(null);
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
    setPageUrl(href === "about:blank" ? "" : href);
    if (document.activeElement !== address.current) setDraft(href === "about:blank" ? "" : href);
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
    const onInPageNav = (event: Event): void => {
      if ((event as Event & { isMainFrame?: boolean }).isMainFrame !== false) sync(view);
    };
    const onNav = (): void => {
      setLoadError(null);
      setFailedUrl(null);
      setPicking(false);
      setFavicon(undefined);
      sync(view);
    };
    const onFavicon = (event: Event): void => {
      const picked = pickFavicon((event as FaviconEvent).favicons);
      if (picked) setFavicon(picked);
    };
    const onStart = (): void => { setLoading(true); setLoadError(null); };
    const onFail = (event: Event): void => {
      const failure = event as Event & { isMainFrame?: boolean; errorCode?: number; errorDescription?: string; validatedURL?: string };
      if (failure.isMainFrame === false || failure.errorCode === -3) return;
      setFailedUrl(failure.validatedURL ?? null);
      setLoadError(failure.errorDescription || t("browser.loadFailed"));
    };
    const onReady = (): void => { userAgentRef.current(); setZoom(safe(() => view.getZoomFactor(), 1)); };
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
      const detail = event as Event & { result?: { requestId?: number; activeMatchOrdinal?: number; matches?: number } };
      if (detail.result?.requestId !== findRequest.current) return;
      const total = detail.result?.matches ?? 0;
      setFindCount(total > 0 ? { active: detail.result?.activeMatchOrdinal ?? 0, total } : null);
    };
    view.addEventListener("did-fail-load", onFail);
    view.addEventListener("dom-ready", onReady);
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
      view.removeEventListener("did-fail-load", onFail);
      view.removeEventListener("dom-ready", onReady);
      view.removeEventListener("did-start-loading", onStart);
      view.removeEventListener("did-stop-loading", onStop);
      view.removeEventListener("found-in-page", onFound);
    };
  }, [patchTab, tabId]);

  const collapsed = useSidePaneStore((state) => state.collapsed);

  useEffect(() => {
    if (!downloadsOpen) return;
    if (!visible || collapsed) {
      setDownloadsOpen(false);
      return;
    }
    // The guest is a separate Chromium surface: its clicks do not bubble to the
    // popover's outside-press listener. Focus entering it still closes the list.
    const closeDownloads = (): void => setDownloadsOpen(false);
    const view = guest.current;
    view?.addEventListener("focus", closeDownloads);
    window.addEventListener("blur", closeDownloads);
    return () => {
      view?.removeEventListener("focus", closeDownloads);
      window.removeEventListener("blur", closeDownloads);
    };
  }, [downloadsOpen, visible, collapsed]);

  /**
   * Put this guest's layer over the tab's viewport while it is the one on screen,
   * and park it otherwise. The guest itself is never moved (see `getLayer`).
   *
   * Opening the pane does not resize the frame the page sits in — that frame is
   * held at its resting width and slides in, clipped by the panel outside it.
   * A resize observer on the frame never fires for that slide, so the guest was
   * left where the frame started (off the window) until the animation ended and
   * the width came back. Follow the clip's position for the length of the open.
   */
  useEffect(() => {
    const entry = registry.get(tabId);
    const mount = box.current;
    if (!visible || collapsed || !pageUrl || pageUrl === "about:blank" || !entry || !mount) {
      parkGuest(tabId);
      return;
    }
    let raf = 0;
    // Captured once: the clipping boxes don't come and go during an open, and
    // re-walking computed style every frame would only repeat this list.
    const clips = clipAncestors(mount);
    const place = (): { left: number; top: number; width: number; height: number } | null => {
      const node = box.current;
      if (!node) return null;
      const rect = visibleRect(node, clips);
      // Still collapsed to nothing: placing here pins the guest to a 0×0 box.
      // The next real rect is what puts the page on screen.
      if (rect.width < 1 || rect.height < 1) return rect;
      showGuest(entry, rect);
      // Read the preset live: this also runs from the resize observer, which must
      // not put back the size the pane had when the effect was set up.
      if (owner === tabId) placeDevice(entry, viewportRef.current, rect, landscapeRef.current);
      return rect;
    };
    const started = performance.now();
    let last = "";
    let stable = 0;
    const follow = (): void => {
      const rect = place();
      const node = box.current;
      if (!rect || !node) return;
      const key = `${Math.round(rect.left)}|${Math.round(rect.top)}|${Math.round(rect.width)}|${Math.round(rect.height)}`;
      const usable = rect.width >= 1 && rect.height >= 1;
      stable = usable && key === last ? stable + 1 : 0;
      last = key;
      const animating = Boolean(node.closest("[data-animate]"));
      // `data-animate` is written a frame after the pane is told to open.
      const waiting = !usable && performance.now() - started < 400;
      if ((animating || waiting || stable < 2) && performance.now() - started < 800) {
        raf = requestAnimationFrame(follow);
      }
    };
    follow();
    const observer = new ResizeObserver(() => place());
    observer.observe(mount);
    for (const clip of clips) observer.observe(clip);
    window.addEventListener("resize", place);
    return () => {
      cancelAnimationFrame(raf);
      observer.disconnect();
      window.removeEventListener("resize", place);
      parkGuest(tabId);
    };
    // `viewport` is a dependency on purpose, even though `place` reads it through
    // the ref: changing it has to lay the guest out again immediately, and the
    // resize observer will not fire for a change that does not move the pane.
  }, [collapsed, tabId, viewport, landscape, visible, pageUrl]);

  /** A device size has to look like that device to the page, not only be that wide. */
  useEffect(() => {
    if (!visible) return;
    const entry = registry.get(tabId);
    if (entry) { entry.viewport = viewport; entry.landscape = landscape; }
    void applyUserAgent(viewport);
  }, [tabId, viewport, landscape, visible]);

  function go(next = draft): void {
    const href = normalizeUrl(next);
    setDraft(href);
    setLoadError(null);
    void guest.current?.loadURL(href)?.catch(() => undefined);
  }

  function onSubmit(event: FormEvent): void {
    event.preventDefault();
    go();
  }

  async function loadProfiles(): Promise<void> {
    try {
      setProfiles(await window.fastvibe.browser.listProfiles());
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    }
  }

  async function importProfile(profile: BrowserProfileInfo): Promise<void> {
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
    const entry = registry.get(tabId);
    if (entry) entry.originalUserAgent = base;
    const next = mode === "responsive" ? base : base
      .replace(/\([^)]*\)/, mode === "mobile" ? "(Linux; Android 14; Pixel 8)" : "(Linux; Android 14; Tablet)")
      .replace(/(?:FastVibe|Electron)\/\S+\s*/g, "")
      .replace("Safari/", mode === "mobile" ? "Mobile Safari/" : "Safari/");
    if (safe(() => view.getUserAgent(), "") === next) return;
    view.setUserAgent(next);
    const href = safe(() => view.getURL(), "");
    if (href && href !== "about:blank") view.reload();
  }

  function changeZoom(next: number): void {
    const clamped = Math.min(5, Math.max(0.25, next));
    setZoom(clamped);
    guest.current?.setZoomFactor(clamped);
  }

  function stepZoom(direction: 1 | -1): void {
    changeZoom(nextBrowserZoom(safe(() => guest.current!.getZoomFactor(), zoom), direction));
  }

  function runFind(text: string, again = false, forward = true): void {
    const view = guest.current;
    if (!view?.findInPage) return;
    findRequest.current = null;
    if (!text) {
      view.stopFindInPage?.("clearSelection");
      setFindCount(null);
      return;
    }
    if (!again) setFindCount(null);
    // Electron's findNext names a *new* finding session: true for the first
    // request, false when moving within the existing matches.
    findRequest.current = view.findInPage(text, { forward, findNext: !again });
  }

  function closeFind(): void {
    setFinding(false);
    findRequest.current = null;
    setFindCount(null);
    guest.current?.focus();
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
      id: randomUUID(),
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

  userAgentRef.current = () => { void applyUserAgent(viewportRef.current); };

  function openFind(): void {
    setFinding(true);
    window.setTimeout(() => { findBox.current?.querySelector("input")?.focus(); findBox.current?.querySelector("input")?.select(); }, 0);
    if (findText) runFind(findText);
  }

  async function capture(): Promise<void> {
    if (!guest.current || capturing) return;
    setCapturing(true);
    try {
      const path = await window.fastvibe.browser.capture(guest.current.getWebContentsId());
      if (path) toast.success(t("browser.captureSaved"), { description: path });
    } catch (error) { toast.error(t("browser.captureFailed"), { description: String(error) }); }
    finally { setCapturing(false); }
  }

  async function print(): Promise<void> {
    try { if (guest.current) await window.fastvibe.browser.print(guest.current.getWebContentsId()); }
    catch (error) { toast.error(t("browser.printFailed"), { description: String(error) }); }
  }

  shortcutRef.current = (command) => {
    if (historyOpen || clearing) return;
    if (downloadsOpen) setDownloadsOpen(false);
    const view = guest.current;
    switch (command) {
      case "address": address.current?.focus(); address.current?.select(); break;
      case "find": openFind(); break;
      case "print": if (pageUrl) void print(); break;
      case "reload": view?.reload(); break;
      case "reloadIgnoringCache": view?.reloadIgnoringCache(); break;
      case "zoomIn": stepZoom(1); break;
      case "zoomOut": stepZoom(-1); break;
      case "zoomReset": changeZoom(1); break;
      case "back": if (canGoBack) view?.goBack(); break;
      case "forward": if (canGoForward) view?.goForward(); break;
      case "escape":
        if (finding) closeFind();
        if (picking) void togglePick();
        if (loading) view?.stop();
        break;
    }
  };

  useEffect(() => {
    if (!visible || collapsed) return;
    const unsubscribe = window.fastvibe.browser.onShortcut(({ guestId, command, at }) => {
      // Shortcut pushes may be replayed when an App Protocol client reconnects.
      if (Date.now() - at > 3000) return;
      if (safe(() => guest.current?.getWebContentsId(), -1) === guestId) shortcutRef.current(command);
    });
    const onKey = (event: KeyboardEvent): void => {
      if (!root.current?.contains(event.target as Node)) return;
      const command = browserShortcut({ key: event.key, control: event.ctrlKey, meta: event.metaKey, alt: event.altKey, shift: event.shiftKey }, /Mac/.test(navigator.platform));
      if (!command) return;
      event.preventDefault(); event.stopPropagation();
      shortcutRef.current(command);
    };
    window.addEventListener("keydown", onKey, true);
    return () => { unsubscribe(); window.removeEventListener("keydown", onKey, true); };
  }, [visible, collapsed]);

  useEffect(() => {
    if (!visible || collapsed) return;
    let disposed = false;
    let revision = 0;
    const refresh = async (): Promise<void> => {
      const request = ++revision;
      try {
        const next = await window.fastvibe.browser.library();
        if (!disposed && request === revision) { setLibrary(next); setLibraryError(null); }
      } catch (error) { if (!disposed && request === revision) setLibraryError(String(error)); }
    };
    const unsubscribe = window.fastvibe.browser.onLibraryChanged(() => void refresh());
    void refresh();
    return () => { disposed = true; unsubscribe(); };
  }, [visible, collapsed]);

  const hasPage = !!pageUrl && pageUrl !== "about:blank";
  const modifier = /Mac/.test(navigator.platform) ? "⌘" : "Ctrl+";
  const viewportIcon = viewport === "mobile" ? SmartPhone01Icon : viewport === "tablet" ? Tablet01Icon : ComputerIcon;


  return (
    <div ref={root} className="flex min-h-0 flex-1 flex-col bg-background" aria-hidden={!visible}>
      <form className="relative flex h-12 min-w-0 shrink-0 items-center gap-1.5 border-b border-border/60 px-2" onSubmit={onSubmit}>
        <div className="flex shrink-0 items-center rounded-full border border-border/60 p-0.5">
          <IconButton className="aria-disabled:opacity-50" type="button" size="icon-xs" variant="ghost" focusableWhenDisabled disabled={!canGoBack} label={t("browser.back")} onClick={() => guest.current?.goBack()}><HugeiconsIcon strokeWidth={2} icon={ArrowLeft01Icon} /></IconButton>
          <IconButton className="aria-disabled:opacity-50" type="button" size="icon-xs" variant="ghost" focusableWhenDisabled disabled={!canGoForward} label={t("browser.forward")} onClick={() => guest.current?.goForward()}><HugeiconsIcon strokeWidth={2} icon={ArrowRight01Icon} /></IconButton>
          <IconButton type="button" size="icon-xs" variant="ghost" label={t(loading ? "browser.stop" : "browser.reload")} onClick={() => loading ? guest.current?.stop() : guest.current?.reload()}><HugeiconsIcon strokeWidth={2} icon={loading ? Cancel01Icon : Refresh01Icon} /></IconButton>
        </div>
        <IconButton className="aria-disabled:opacity-50" type="button" size="icon-xs" variant={picking ? "secondary" : "ghost"} focusableWhenDisabled disabled={!hasPage} aria-pressed={picking} label={t(picking ? "browser.pickCancel" : "browser.pick")} onClick={() => void togglePick()}><HugeiconsIcon strokeWidth={2} icon={CursorRectangleSelection01Icon} /></IconButton>
        <div className="relative flex min-w-0 flex-1 items-center">
          <Input ref={address} value={draft} aria-label={t("browser.placeholder")} placeholder={t("browser.placeholder")} className="h-8 w-full min-w-0 rounded-full bg-muted/40 pr-7 text-xs" spellCheck={false} onFocus={(event) => event.currentTarget.select()} onBlur={() => setDraft(failedUrl || pageUrl)} onChange={(event) => setDraft(event.target.value)} />
          <IconButton type="button" size="icon-xs" variant="ghost" className="aria-disabled:opacity-50 absolute inset-y-0 right-0.5 my-auto" focusableWhenDisabled disabled={!hasPage} label={t("browser.openExternal")} onClick={() => window.open(pageUrl, "_blank")}><HugeiconsIcon strokeWidth={2} icon={LinkSquare02Icon} /></IconButton>
        </div>
        <BrowserDownloadsPopover
          open={downloadsOpen}
          onOpenChange={setDownloadsOpen}
          library={library}
          error={libraryError}
        />
        <DropdownMenu onOpenChange={(open) => { if (open) { void loadProfiles(); setZoom(safe(() => guest.current!.getZoomFactor(), zoom)); } }}>
          <DropdownMenuTrigger render={<IconButton type="button" size="icon-xs" variant="ghost" label={t("browser.more")}><HugeiconsIcon strokeWidth={2} icon={MoreHorizontalIcon} /></IconButton>} />
          <DropdownMenuContent align="end" className="min-w-64">
            <DropdownMenuItem disabled={!hasPage} onClick={openFind}><HugeiconsIcon icon={Search01Icon} />{t("browser.find")}<span className="ml-auto text-xs text-muted-foreground">{modifier}F</span></DropdownMenuItem>
            <DropdownMenuItem disabled={!hasPage} onClick={() => void print()}><HugeiconsIcon icon={PrinterIcon} />{t("browser.print")}<span className="ml-auto text-xs text-muted-foreground">{modifier}P</span></DropdownMenuItem>
            <DropdownMenuSeparator />
            <div className="flex items-center gap-1 px-2 py-1.5" role="group" aria-label={t("browser.zoom")}>
              <span className="mr-auto text-sm">{t("browser.zoom")}</span>
              <IconButton className="aria-disabled:opacity-50" type="button" size="icon-xs" variant="ghost" focusableWhenDisabled disabled={zoom <= 0.25} label={t("browser.zoomOut")} onClick={() => stepZoom(-1)}><HugeiconsIcon icon={MinusSignIcon} /></IconButton>
              <span className="w-12 text-center text-sm tabular-nums">{Math.round(zoom * 100)}%</span>
              <IconButton className="aria-disabled:opacity-50" type="button" size="icon-xs" variant="ghost" focusableWhenDisabled disabled={zoom >= 5} label={t("browser.zoomIn")} onClick={() => stepZoom(1)}><HugeiconsIcon icon={PlusSignIcon} /></IconButton>
              <IconButton className="aria-disabled:opacity-50" type="button" size="icon-xs" variant="ghost" focusableWhenDisabled disabled={zoom === 1} label={t("browser.zoomReset")} onClick={() => changeZoom(1)}><HugeiconsIcon icon={Refresh01Icon} /></IconButton>
            </div>
            <DropdownMenuSeparator />
            <DropdownMenuSub>
              <DropdownMenuSubTrigger><HugeiconsIcon icon={viewportIcon} />{t("browser.deviceToolbar")}</DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="min-w-56">
                <DropdownMenuRadioGroup value={viewport} onValueChange={(value) => setViewport(value as ViewportMode)}>
                  <DropdownMenuRadioItem value="responsive">{t("browser.responsive")}<span className="ml-auto text-xs text-muted-foreground">100%</span></DropdownMenuRadioItem>
                  <DropdownMenuRadioItem value="mobile">{t("browser.mobile")}<span className="ml-auto text-xs text-muted-foreground">375 × 812</span></DropdownMenuRadioItem>
                  <DropdownMenuRadioItem value="tablet">{t("browser.tablet")}<span className="ml-auto text-xs text-muted-foreground">768 × 1024</span></DropdownMenuRadioItem>
                </DropdownMenuRadioGroup>
              </DropdownMenuSubContent>
            </DropdownMenuSub>
            <DropdownMenuItem disabled={!hasPage || capturing} onClick={() => void capture()}><HugeiconsIcon icon={Camera01Icon} />{t(capturing ? "browser.capturing" : "browser.capture")}</DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuSub>
              <DropdownMenuSubTrigger><HugeiconsIcon icon={Upload01Icon} />{t("browser.importHeading")}</DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="max-h-72 min-w-64">
                <DropdownMenuGroup><DropdownMenuLabel>{t("browser.importTitle")}</DropdownMenuLabel>
                  {profiles.length === 0 ? <DropdownMenuItem disabled>{t("browser.noProfiles")}</DropdownMenuItem> : profiles.map((profile) => <DropdownMenuItem key={profile.id} disabled={importing} onClick={() => void importProfile(profile)}><span className="min-w-0 flex-1 truncate">{profile.browser} · {profile.name}</span></DropdownMenuItem>)}
                </DropdownMenuGroup>
              </DropdownMenuSubContent>
            </DropdownMenuSub>
            <DropdownMenuItem onClick={() => window.setTimeout(() => setDownloadsOpen(true), 0)}><HugeiconsIcon icon={Download01Icon} />{t("browser.downloads")}</DropdownMenuItem>
            <DropdownMenuItem onClick={() => setHistoryOpen(true)}><HugeiconsIcon icon={Clock01Icon} />{t("browser.history")}</DropdownMenuItem>
            <DropdownMenuItem disabled={!hasPage} onClick={() => void copyUrl()}><HugeiconsIcon icon={Copy01Icon} />{t("browser.copyUrl")}</DropdownMenuItem>
            <DropdownMenuItem onClick={() => setClearing(true)}><HugeiconsIcon icon={Delete02Icon} />{t("browser.clearData")}</DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => navigate("/settings/browser")}><HugeiconsIcon icon={Settings01Icon} />{t("browser.settings")}</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        {loading && <div role="progressbar" aria-label={t("browser.loadingPage")} className="pointer-events-none absolute inset-x-0 bottom-0 h-0.5 animate-pulse bg-primary/60" />}
      </form>
      {viewport !== "responsive" && <div className="flex h-9 shrink-0 items-center justify-center gap-3 border-b border-border bg-muted/40 px-2 text-xs text-muted-foreground">
        <HugeiconsIcon icon={viewportIcon} className="size-3.5" /><span>{t(`browser.${viewport}`)}</span>
        <span className="tabular-nums">{viewport === "mobile" ? (landscape ? "812 × 375" : "375 × 812") : (landscape ? "1024 × 768" : "768 × 1024")}</span>
        <IconButton type="button" size="icon-xs" variant="ghost" label={t("browser.rotate")} onClick={() => setLandscape(!landscape)}><HugeiconsIcon icon={RotateRight01Icon} /></IconButton>
        <IconButton type="button" size="icon-xs" variant="ghost" label={t("browser.closeDevice")} onClick={() => setViewport("responsive")}><HugeiconsIcon icon={Cancel01Icon} /></IconButton>
      </div>}
      {loadError && <div role="alert" className="flex items-center gap-2 border-b border-border bg-muted/40 px-3 py-2 text-xs"><span className="min-w-0 flex-1 break-words">{t("browser.loadFailed")} · {loadError}</span><Button size="xs" variant="outline" onClick={() => go(failedUrl || pageUrl || draft)}>{t("browser.retry")}</Button></div>}
      {picking ? (
        <div className="truncate px-3 pb-1 text-xs text-muted-foreground">{t("browser.pickHint")}</div>
      ) : null}
      <div ref={box} className="relative min-h-0 min-w-0 flex-1 overflow-hidden bg-white">
        {!hasPage ? (
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
            aria-label={t("browser.findPlaceholder")}
            onKeyDown={(event) => { if (event.key === "Enter" && event.shiftKey) { event.preventDefault(); runFind(findText, true, false); } }}
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
          <IconButton className="aria-disabled:opacity-50" type="button" size="icon-xs" variant="ghost" label={t("browser.findPrev")} focusableWhenDisabled disabled={!findText || !findCount} onClick={() => runFind(findText, true, false)}>
            <HugeiconsIcon strokeWidth={2} icon={ArrowUp01Icon} />
          </IconButton>
          <IconButton className="aria-disabled:opacity-50" type="submit" size="icon-xs" variant="ghost" label={t("browser.findNext")} focusableWhenDisabled disabled={!findText || !findCount}>
            <HugeiconsIcon strokeWidth={2} icon={ArrowDown01Icon} />
          </IconButton>
          <IconButton type="button" size="icon-xs" variant="ghost" label={t("browser.findClose")} onClick={closeFind}>
            <HugeiconsIcon strokeWidth={2} icon={Cancel01Icon} />
          </IconButton>
        </form>
      ) : null}
      <BrowserHistoryDialog open={historyOpen} library={library} error={libraryError} close={() => setHistoryOpen(false)} go={go} />
      <BrowserClearDialog open={clearing} close={() => setClearing(false)} onCleared={(options) => { if (options.cookies || options.cache) guest.current?.reload(); }} />
    </div>
  );
}
