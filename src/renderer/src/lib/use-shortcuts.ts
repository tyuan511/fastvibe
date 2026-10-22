import { useEffect, useRef } from "react";
import type { MenuCommandId } from "@shared/menu-commands";
import { useSettingsStore } from "@/stores/settings";
import { nativeMenuOwns } from "@/lib/native-menu";
import {
  SHORTCUT_CATALOG,
  formatChord,
  isShortcutRecording,
  matchChord,
  resolveBinding,
  resolveBindings,
  shouldYieldToTerminal,
  type ShortcutHandler,
  type ShortcutId,
} from "@/lib/shortcuts";

export function useShortcutLabel(id: ShortcutId): string | undefined {
  const overrides = useSettingsStore((state) => state.settings.shortcuts);
  const binding = resolveBinding(id, overrides);
  return binding ? formatChord(binding) : undefined;
}

/**
 * Global dispatcher. Handlers return `false` to leave the event alone (e.g. Esc
 * when nothing is running). A match always stops looking for a second command.
 */
export function useAppShortcuts(handlers: Partial<Record<ShortcutId, ShortcutHandler>>): void {
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;
  const overrides = useSettingsStore((state) => state.settings.shortcuts);

  useEffect(() => {
    function onKey(event: KeyboardEvent): void {
      if (event.defaultPrevented || event.isComposing || event.repeat) return;
      if (isShortcutRecording()) return;
      if (shouldYieldToTerminal(event)) return;
      const bindings = resolveBindings(overrides);
      for (const item of SHORTCUT_CATALOG) {
        const chord = bindings[item.id];
        if (!chord || !matchChord(event, chord)) continue;
        // The Mac's menu bar registered this key, so it already ran the command — a second
        // answer here would flip the toggle straight back.
        if (nativeMenuOwns(item.id)) return;
        const handler = handlersRef.current[item.id];
        if (!handler) return;
        const result = handler(event);
        if (result !== false) event.preventDefault();
        return;
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [overrides]);
}

/**
 * The other half of the same table: commands that arrived from the native menu bar, which
 * carries no key event. Handlers keep the dispatcher's signature and are handed `null`.
 */
export function useNativeMenuActions(actions: Partial<Record<MenuCommandId, ShortcutHandler>>): void {
  const actionsRef = useRef(actions);
  actionsRef.current = actions;

  useEffect(() => {
    const onAction = window.fastvibe.menu?.onAction;
    if (!onAction) return;
    return onAction(({ id }) => {
      actionsRef.current[id]?.(null);
    });
  }, []);
}
