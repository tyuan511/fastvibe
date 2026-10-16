import { useEffect, useRef, useState, type JSX } from "react";
import { useTranslation } from "react-i18next";
import { HugeiconsIcon } from "@hugeicons/react";
import { ArrowDown01Icon, ArrowUp01Icon, Cancel01Icon, Search01Icon } from "@hugeicons/core-free-icons";
import { i18n } from "@/lib/i18n";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useSidePaneStore } from "@/stores/side-pane";
import { useSettingsStore } from "@/stores/settings";
import {
  getTerminalStash,
  terminalRegistry as registry,
  type TerminalEntry as Entry,
} from "./side-pane-terminal-registry";
import "@xterm/xterm/css/xterm.css";

export { releaseTerminal } from "./side-pane-terminal-registry";

/** Both detected URLs and explicit OSC 8 hyperlinks use the desktop's external opener. */
function openTerminalLink(event: MouseEvent, uri: string): void {
  event.preventDefault();
  try {
    const url = new URL(uri);
    if (url.protocol !== "http:" && url.protocol !== "https:") return;
    window.open(url.href, "_blank", "noopener,noreferrer");
  } catch {
    // Ignore malformed links printed by a shell program.
  }
}

/**
 * Terminal font follows the 界面字号 preference. xterm's canvas needs a plain px
 * number, so resolve the root size from <html> (the setting writes it inline).
 */
function rootFontSize(): number {
  const size = Number.parseFloat(getComputedStyle(document.documentElement).fontSize);
  return Number.isFinite(size) && size > 0 ? size : 16;
}

function readTheme(): Terminal["options"]["theme"] {
  const style = getComputedStyle(document.documentElement);
  const background = style.getPropertyValue("--code-bg").trim() || style.getPropertyValue("--background").trim();
  const foreground = style.getPropertyValue("--foreground").trim();
  return { background, foreground, cursor: foreground };
}

export function SidePaneTerminal({
  tabId,
  cwd,
  sessionId,
  visible,
}: {
  tabId: string;
  cwd?: string;
  sessionId?: string;
  visible: boolean;
}): JSX.Element {
  const { t } = useTranslation("sidepane");
  const patchTab = useSidePaneStore((state) => state.patchTab);
  const uiFontSize = useSettingsStore((state) => state.settings.uiFontSize);
  const box = useRef<HTMLDivElement>(null);
  const findInput = useRef<HTMLInputElement>(null);
  const [finding, setFinding] = useState(false);
  const [findText, setFindText] = useState("");
  const [notFound, setNotFound] = useState(false);
  const visibleRef = useRef(visible);
  visibleRef.current = visible;

  function runFind(text: string, previous = false, incremental = false): void {
    const entry = registry.get(tabId);
    if (!entry) return;
    // Search uses the normal selection highlight, keeping proposed xterm APIs disabled.
    const found = previous
      ? entry.search.findPrevious(text)
      : entry.search.findNext(text, { incremental });
    setNotFound(Boolean(text) && !found);
  }

  function closeFind(): void {
    setFinding(false);
    setNotFound(false);
    const entry = registry.get(tabId);
    entry?.search.clearDecorations();
    entry?.term.clearSelection();
    entry?.term.focus();
  }

  useEffect(() => {
    if (finding && visible) {
      findInput.current?.focus();
      findInput.current?.select();
    }
  }, [finding, visible]);

  useEffect(() => {
    if (!visible) return;
    const entry = registry.get(tabId);
    if (!entry) return;
    try {
      entry.fit.fit();
    } catch {
      // ignore
    }
    if (finding) findInput.current?.focus();
    else entry.term.focus();
    if (entry.sessionId) void window.fastvibe.workspace.terminalResize(entry.sessionId, entry.term.cols, entry.term.rows);
  }, [tabId, visible]);

  useEffect(() => {
    const mount = box.current;
    if (!mount) return;
    let entry = registry.get(tabId);
    if (entry) {
      if (entry.host.parentElement !== mount) mount.appendChild(entry.host);
      return () => {
        if (entry && entry.host.parentElement === mount) getTerminalStash().appendChild(entry.host);
      };
    }

    const host = document.createElement("div");
    host.className = "h-full min-h-0 w-full overflow-hidden";
    mount.appendChild(host);
    const term = new Terminal({
      fontSize: Math.round(rootFontSize() * (13 / 16)),
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
      theme: readTheme(),
      cursorBlink: true,
      allowProposedApi: false,
      linkHandler: { activate: openTerminalLink },
    });
    const fit = new FitAddon();
    const search = new SearchAddon();
    term.loadAddon(fit);
    term.loadAddon(search);
    term.loadAddon(new WebLinksAddon(openTerminalLink));
    term.open(host);
    const observers: Array<{ disconnect: () => void }> = [];
    const themeWatch = new MutationObserver(() => {
      term.options.theme = readTheme();
    });
    themeWatch.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "style"] });
    observers.push(themeWatch);
    try {
      fit.fit();
    } catch {
      // ignore
    }
    const created: Entry = {
      term,
      fit,
      search,
      host,
      sessionId,
      dispose: () => undefined,
    };
    registry.set(tabId, created);

    let cancelled = false;
    const off = window.fastvibe.workspace.onTerminalData((event) => {
      if (event.id !== created.sessionId) return;
      if (event.data) term.write(event.data);
      if (event.exited) term.write(`\r\n${i18n.t("sidepane:terminal.ended")}\r\n`);
    });

    void window.fastvibe.workspace
      .terminalStart(cwd, { cols: term.cols, rows: term.rows })
      .then((session) => {
        if (cancelled) {
          void window.fastvibe.workspace.terminalKill(session.id);
          return;
        }
        created.sessionId = session.id;
        // Pin the resolved cwd (home when no project is bound) so the shell does
        // not respawn as the active project changes.
        patchTab(tabId, { sessionId: session.id, cwd: session.cwd });
        void window.fastvibe.workspace.terminalResize(session.id, term.cols, term.rows);
      })
      .catch(() => undefined);

    const dataSub = term.onData((data) => {
      if (created.sessionId) void window.fastvibe.workspace.terminalWrite(created.sessionId, data);
    });
    term.attachCustomKeyEventHandler((event) => {
      if (event.type !== "keydown" || !(event.metaKey || event.ctrlKey)) return true;
      const key = event.key.toLowerCase();
      if (key === "c" && term.hasSelection()) {
        void navigator.clipboard.writeText(term.getSelection());
        return false;
      }
      if (key === "v") {
        event.preventDefault();
        void navigator.clipboard.readText().then((text) => {
          if (text) term.paste(text);
        });
        return false;
      }
      return true;
    });

    let frame = 0;
    const resize = (): void => {
      if (!visibleRef.current || host.clientWidth <= 0 || host.clientHeight <= 0) return;
      try {
        fit.fit();
      } catch {
        return;
      }
      if (created.sessionId) void window.fastvibe.workspace.terminalResize(created.sessionId, term.cols, term.rows);
    };
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(resize);
    });
    observer.observe(host);
    observers.push(observer);

    created.dispose = () => {
      cancelled = true;
      off();
      dataSub.dispose();
      for (const item of observers) item.disconnect();
      if (created.sessionId) void window.fastvibe.workspace.terminalKill(created.sessionId);
      try {
        term.dispose();
      } catch {
        // ignore
      }
    };

    return () => {
      if (created.host.parentElement === mount) getTerminalStash().appendChild(created.host);
    };
  }, [cwd, patchTab, tabId]);

  // 界面字号 changed: resize the existing terminal instead of rebuilding it.
  useEffect(() => {
    const entry = registry.get(tabId);
    if (!entry) return;
    entry.term.options.fontSize = Math.round(rootFontSize() * (13 / 16));
    try {
      entry.fit.fit();
    } catch {
      // ignore
    }
    if (entry.sessionId) void window.fastvibe.workspace.terminalResize(entry.sessionId, entry.term.cols, entry.term.rows);
  }, [uiFontSize, tabId]);

  return (
    <div
      className="relative flex h-full min-h-0 w-full flex-col bg-[var(--code-bg)]"
      onKeyDownCapture={(event) => {
        if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === "f") {
          event.preventDefault();
          event.stopPropagation();
          setFinding(true);
          findInput.current?.focus();
          findInput.current?.select();
        } else if (finding && event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          closeFind();
        }
      }}
    >
      <div ref={box} className="min-h-0 w-full flex-1 p-2" />
      {finding ? (
        <form
          className="absolute top-2 right-2 z-10 flex h-9 w-[calc(100%-1rem)] max-w-sm items-center gap-1 rounded-lg border border-border bg-popover px-2 shadow-md"
          onSubmit={(event) => {
            event.preventDefault();
            runFind(findText);
          }}
        >
          <HugeiconsIcon strokeWidth={2} icon={Search01Icon} className="size-3.5 text-muted-foreground" />
          <Input
            ref={findInput}
            value={findText}
            aria-label={t("terminal.findPlaceholder")}
            placeholder={t("terminal.findPlaceholder")}
            className="h-6 flex-1 border-0 bg-transparent px-1 text-xs shadow-none focus-visible:ring-0"
            spellCheck={false}
            onChange={(event) => {
              setFindText(event.target.value);
              runFind(event.target.value, false, true);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                runFind(findText, event.shiftKey);
              }
            }}
          />
          <span role="status" className="shrink-0 text-xs text-muted-foreground">
            {notFound ? t("terminal.findEmpty") : ""}
          </span>
          <Button type="button" size="icon-xs" variant="ghost" disabled={!findText} aria-label={t("terminal.findPrev")} title={t("terminal.findPrev")} onClick={() => runFind(findText, true)}>
            <HugeiconsIcon strokeWidth={2} icon={ArrowUp01Icon} />
          </Button>
          <Button type="submit" size="icon-xs" variant="ghost" disabled={!findText} aria-label={t("terminal.findNext")} title={t("terminal.findNext")}>
            <HugeiconsIcon strokeWidth={2} icon={ArrowDown01Icon} />
          </Button>
          <Button type="button" size="icon-xs" variant="ghost" aria-label={t("terminal.findClose")} title={t("terminal.findClose")} onClick={closeFind}>
            <HugeiconsIcon strokeWidth={2} icon={Cancel01Icon} />
          </Button>
        </form>
      ) : null}
    </div>
  );
}
