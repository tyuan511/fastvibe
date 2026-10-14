import { useCallback, useRef, useState, type CSSProperties, type JSX, type KeyboardEvent, type PointerEvent } from "react";
import { cn } from "@/lib/utils";
import { useSettingsStore } from "@/stores/settings";

/** What a list column may be dragged to, and the room its neighbour keeps. */
const MIN_LIST = 120;
const MIN_REST = 192;
const KEY_STEP = 16;

/**
 * The width of one side-pane view's list column, remembered per view in
 * `settings.json` (`sidePaneSplits`). Held locally while dragging so a drag does not
 * rewrite the preference every frame; it is written once, when the pointer lets go.
 */
export function useSplitWidth(
  view: string,
  fallback: number,
): { width: number; setWidth: (width: number) => void; commit: (width: number) => void; reset: () => void } {
  const stored = useSettingsStore((state) => state.settings.sidePaneSplits?.[view]);
  const [draft, setDraft] = useState<number | null>(null);
  const width = draft ?? stored ?? fallback;

  const commit = useCallback(
    (next: number): void => {
      setDraft(null);
      const store = useSettingsStore.getState();
      const current = store.settings.sidePaneSplits ?? {};
      if (current[view] === next) return;
      store.update({ sidePaneSplits: { ...current, [view]: next } });
    },
    [view],
  );

  const reset = useCallback((): void => {
    setDraft(null);
    const store = useSettingsStore.getState();
    const current = store.settings.sidePaneSplits;
    if (!current || !(view in current)) return;
    const { [view]: _gone, ...rest } = current;
    store.update({ sidePaneSplits: rest });
  }, [view]);

  return { width, setWidth: setDraft, commit, reset };
}

/** Style carrying the width for a `w-(--split-w)` class that only applies in the wide layout. */
export function splitStyle(width: number): CSSProperties {
  return { "--split-w": `${width}px` } as CSSProperties;
}

/**
 * The draggable seam between a view's list column and its content. `listSide` says
 * which side the list is on: dragging towards the content grows it. Pointer capture
 * keeps the drag alive when the pointer leaves the handle, and always ends it.
 */
export function SplitHandle({
  listSide,
  width,
  setWidth,
  commit,
  reset,
  label,
  className,
}: {
  listSide: "start" | "end";
  width: number;
  setWidth: (width: number) => void;
  commit: (width: number) => void;
  reset: () => void;
  label: string;
  className?: string;
}): JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; width: number; max: number } | null>(null);
  const [active, setActive] = useState(false);

  const clamp = (value: number, max: number): number => Math.round(Math.max(MIN_LIST, Math.min(max, value)));
  const containerMax = (): number => {
    const parent = ref.current?.parentElement;
    return Math.max(MIN_LIST, (parent?.getBoundingClientRect().width ?? 0) - MIN_REST);
  };
  const sign = listSide === "start" ? 1 : -1;

  function onPointerDown(event: PointerEvent<HTMLDivElement>): void {
    if (event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    // Measure the list as it is drawn: a stored width may have been squeezed by its container.
    const list = listSide === "start" ? ref.current?.previousElementSibling : ref.current?.nextElementSibling;
    const drawn = list?.getBoundingClientRect().width ?? width;
    drag.current = { x: event.clientX, width: drawn, max: containerMax() };
    setActive(true);
    event.preventDefault();
  }

  function onPointerMove(event: PointerEvent<HTMLDivElement>): void {
    const start = drag.current;
    if (!start) return;
    setWidth(clamp(start.width + sign * (event.clientX - start.x), start.max));
  }

  function end(event: PointerEvent<HTMLDivElement>): void {
    const start = drag.current;
    if (!start) return;
    drag.current = null;
    setActive(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    commit(clamp(start.width + sign * (event.clientX - start.x), start.max));
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const delta = (event.key === "ArrowRight" ? 1 : -1) * sign * KEY_STEP;
    commit(clamp(width + delta, containerMax()));
  }

  return (
    <div
      ref={ref}
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={Math.round(width)}
      aria-valuemin={MIN_LIST}
      tabIndex={0}
      data-separator={active ? "active" : undefined}
      className={cn(
        "relative z-20 w-px shrink-0 cursor-col-resize touch-none bg-border transition-colors",
        // A hairline is too narrow to grab; widen the target without taking layout space.
        "after:absolute after:inset-y-0 after:-left-1.5 after:-right-1.5 after:content-['']",
        "hover:bg-ring/40 focus-visible:bg-ring/40 data-[separator=active]:bg-ring/60",
        className,
      )}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={end}
      onPointerCancel={end}
      onDoubleClick={reset}
      onKeyDown={onKeyDown}
    />
  );
}
