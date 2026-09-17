import type { Terminal } from "@xterm/xterm";
import type { FitAddon } from "@xterm/addon-fit";

/**
 * The live terminals, kept apart from the component that creates them.
 *
 * `SidePaneTerminal` pulls in `@xterm/xterm` — several hundred KB that nothing needs
 * until a 终端 tab is opened — so the component is loaded lazily. Disposal, though,
 * has to stay synchronous and eagerly reachable: `disposeSidePaneTabs` runs when a
 * conversation is deleted or archived, and awaiting a chunk there would let a shell
 * outlive the tab that owned it. Both imports above are type-only, so this module
 * costs nothing at runtime; an install that never opens a terminal simply finds an
 * empty registry.
 */
export type TerminalEntry = {
  term: Terminal;
  fit: FitAddon;
  host: HTMLDivElement;
  sessionId?: string;
  dispose: () => void;
};

export const terminalRegistry = new Map<string, TerminalEntry>();

let stash: HTMLDivElement | null = null;

/** Off-screen home for a terminal whose tab is hidden but not closed. */
export function getTerminalStash(): HTMLDivElement {
  if (!stash) {
    stash = document.createElement("div");
    stash.setAttribute("data-side-pane-terminal-stash", "");
    stash.style.display = "none";
    document.body.appendChild(stash);
  }
  return stash;
}

export function releaseTerminal(tabId: string): void {
  const entry = terminalRegistry.get(tabId);
  if (!entry) return;
  terminalRegistry.delete(tabId);
  entry.dispose();
  entry.host.remove();
}
