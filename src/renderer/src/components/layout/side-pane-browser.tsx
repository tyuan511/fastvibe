import { useEffect, useRef, useState, type FormEvent, type JSX } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
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
import { Ipc } from "@shared/ipc";
import type { BrowserImportResult, BrowserProfileInfo, BrowserRequest, ChatAttachment } from "@shared/types";
import {
  type Entry,
  type FaviconEvent,
  type Guest,
  PICK_BODY,
  PICK_READ_BODY,
  PICK_TEXT_LIMIT,
  type ViewportMode,
  ZOOM_STEPS,
  clipAncestor,
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
