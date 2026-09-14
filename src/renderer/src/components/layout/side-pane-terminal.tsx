import { useEffect, useRef, type JSX } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { useSidePaneStore } from "@/stores/side-pane";
import "@xterm/xterm/css/xterm.css";

type Entry = {
  term: Terminal;
  fit: FitAddon;
  host: HTMLDivElement;
  sessionId?: string;
  dispose: () => void;
};

const registry = new Map<string, Entry>();
let stash: HTMLDivElement | null = null;

function getStash(): HTMLDivElement {
  if (!stash) {
    stash = document.createElement("div");
    stash.setAttribute("data-side-pane-terminal-stash", "");
    stash.style.display = "none";
    document.body.appendChild(stash);
  }
  return stash;
}

function readTheme(): Terminal["options"]["theme"] {
  const style = getComputedStyle(document.documentElement);
  const background = style.getPropertyValue("--code-bg").trim() || style.getPropertyValue("--background").trim();
  const foreground = style.getPropertyValue("--foreground").trim();
  return { background, foreground, cursor: foreground };
}

export function releaseTerminal(tabId: string): void {
  const entry = registry.get(tabId);
  if (!entry) return;
  registry.delete(tabId);
  entry.dispose();
  entry.host.remove();
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
  const patchTab = useSidePaneStore((state) => state.patchTab);
  const box = useRef<HTMLDivElement>(null);
  const visibleRef = useRef(visible);
  visibleRef.current = visible;

  useEffect(() => {
    if (!visible) return;
    const entry = registry.get(tabId);
    if (!entry) return;
    try {
      entry.fit.fit();
    } catch {
      // ignore
    }
    entry.term.focus();
    if (entry.sessionId) void window.fastvibe.workspace.terminalResize(entry.sessionId, entry.term.cols, entry.term.rows);
  }, [tabId, visible]);

  useEffect(() => {
    const mount = box.current;
    if (!mount) return;
    let entry = registry.get(tabId);
    if (entry) {
      if (entry.host.parentElement !== mount) mount.appendChild(entry.host);
      return () => {
        if (entry && entry.host.parentElement === mount) getStash().appendChild(entry.host);
      };
    }

    const host = document.createElement("div");
    host.className = "h-full min-h-0 w-full overflow-hidden";
    mount.appendChild(host);
    const term = new Terminal({
      fontSize: 13,
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
      theme: readTheme(),
      cursorBlink: true,
      allowProposedApi: false,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
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
      host,
      sessionId,
      dispose: () => undefined,
    };
    registry.set(tabId, created);

    let cancelled = false;
    const off = window.fastvibe.workspace.onTerminalData((event) => {
      if (event.id !== created.sessionId) return;
      if (event.data) term.write(event.data);
      if (event.exited) term.write("\r\n会话已结束\r\n");
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
      if (created.host.parentElement === mount) getStash().appendChild(created.host);
    };
  }, [cwd, patchTab, tabId]);

  return <div ref={box} className="h-full min-h-0 w-full bg-[var(--code-bg)] p-2" />;
}
