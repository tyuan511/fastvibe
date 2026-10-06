import { useSyncExternalStore } from "react";

/**
 * How many sheets are on screen, closing ones included.
 *
 * A dialog waits for this to reach zero. Picking 删除 in a sheet closes the sheet and
 * asks for confirmation in the same tap, and on iOS a modal presented while another is
 * still being dismissed is silently dropped — the confirmation never appeared.
 */
let open = 0;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

export function sheetOpened(): () => void {
  open += 1;
  emit();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    open -= 1;
    emit();
  };
}

export function useOpenSheets(): number {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => open,
    () => open,
  );
}
