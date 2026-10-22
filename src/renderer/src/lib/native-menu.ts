import { MENU_COMMAND_IDS } from "@shared/menu-commands";
import type { MenuCommandId } from "@shared/menu-commands";
import { isShortcutRecording, resolveBindings } from "@/lib/shortcuts";
import { useSettingsStore } from "@/stores/settings";

/**
 * Talking to the native macOS menu bar.
 *
 * The 快捷键 pane is the one place a chord is decided, so the menu cannot keep its own
 * copy of the truth: this module hands Main what the pane resolved and remembers which
 * commands Main took over. A menu accelerator is consumed by the OS before the page sees
 * the keypress, and a command answered twice is a toggle that appears to do nothing — so
 * the dispatcher skips exactly the ids the menu reported, no more.
 *
 * Anywhere there is no menu — Windows, Linux, the browser preview harness, a remote client
 * whose calls the policy refuses — the answer is empty and the page handles every chord by
 * itself, which is what it did before the menu existed.
 */

let owned = new Set<MenuCommandId>();
/** Only the newest sync may decide the answer; a stale reply must not hand keys back. */
let generation = 0;

export function nativeMenuOwns(id: string): boolean {
  return owned.has(id as MenuCommandId);
}

function effectiveBindings(): Partial<Record<MenuCommandId, string>> {
  const bindings: Partial<Record<MenuCommandId, string>> = {};
  // Capturing a new chord: the menu must release its keys or the recorder never sees them.
  if (isShortcutRecording()) return bindings;
  const resolved: Record<string, string | null> = resolveBindings(useSettingsStore.getState().settings.shortcuts);
  for (const id of MENU_COMMAND_IDS) {
    const chord = resolved[id];
    if (chord) bindings[id] = chord;
  }
  return bindings;
}

export async function syncNativeMenu(): Promise<void> {
  const token = ++generation;
  const bindings = effectiveBindings();
  let ids: MenuCommandId[] = [];
  try {
    const result = await window.fastvibe.menu?.sync(bindings);
    ids = result?.ids ?? [];
  } catch {
    // No menu on this platform, or the call was refused: the page keeps everything.
    ids = [];
  }
  if (token !== generation) return;
  owned = new Set(ids);
}
