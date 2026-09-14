import { useEffect, useRef, useState, type FormEvent, type JSX } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  ArrowLeft01Icon,
  ArrowRight01Icon,
  LinkSquare02Icon,
  Refresh01Icon,
} from "@hugeicons/core-free-icons";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useSidePaneStore } from "@/stores/side-pane";

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
};

type Entry = {
  host: HTMLDivElement;
  view: Guest;
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

function normalizeUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "https://fastvibe.dev";
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return trimmed;
  return `https://${trimmed}`;
}

function safe<T>(read: () => T, fallback: T): T {
  try {
    return read();
  } catch {
    return fallback;
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
      view.src = normalizeUrl(initialUrl.current);
      host.appendChild(view);
      entry = { host, view };
      registry.set(tabId, entry);
    }
    guest.current = entry.view;
    if (entry.host.parentElement !== mount) mount.appendChild(entry.host);

    const view = entry.view;
    const onNav = (): void => sync(view);
    const onStart = (): void => setLoading(true);
    const onStop = (): void => {
      setLoading(false);
      sync(view);
    };
    view.addEventListener("did-navigate", onNav);
    view.addEventListener("did-navigate-in-page", onNav);
    view.addEventListener("page-title-updated", onNav);
    view.addEventListener("did-start-loading", onStart);
    view.addEventListener("did-stop-loading", onStop);
    sync(view);

    return () => {
      view.removeEventListener("did-navigate", onNav);
      view.removeEventListener("did-navigate-in-page", onNav);
      view.removeEventListener("page-title-updated", onNav);
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

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-background" aria-hidden={!visible}>
      <form className="flex h-12 items-center gap-2 px-3" onSubmit={onSubmit}>
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
          placeholder="输入网址后回车"
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
      </form>
      <div ref={box} className="relative min-h-0 min-w-0 flex-1 overflow-hidden bg-white" />
    </div>
  );
}
