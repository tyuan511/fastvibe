import { useRef, useState, type JSX, type MouseEvent as ReactMouseEvent } from "react";
import { cn } from "@/lib/utils";

/**
 * Splitter shared by the left sidebar and the right side pane so both edges
 * resize and look the same. `side` is the edge of the centred panel the handle
 * hugs: "right" for a left sidebar, "left" for a right pane.
 *
 * Feedback is intentionally quiet — a hairline tint on hover and while dragging
 * — so the splitter never reads as a focus ring.
 */
export function ResizeHandle({
  side,
  onDragStart,
  onDrag,
  onDragEnd,
  className,
}: {
  side: "left" | "right";
  /** Called once when a drag begins; record the starting width here. */
  onDragStart?: () => void;
  /** Cumulative horizontal pointer delta in px, positive towards the right. */
  onDrag: (delta: number) => void;
  /** Called once on release with the final delta; persist here. */
  onDragEnd?: (delta: number) => void;
  className?: string;
}): JSX.Element {
  const [dragging, setDragging] = useState(false);
  const startX = useRef(0);

  function handleMouseDown(event: ReactMouseEvent): void {
    event.preventDefault();
    startX.current = event.clientX;
    setDragging(true);
    onDragStart?.();

    const previousCursor = document.body.style.cursor;
    const previousSelect = document.body.style.userSelect;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";

    let lastDelta = 0;
    function move(next: MouseEvent): void {
      lastDelta = next.clientX - startX.current;
      onDrag(lastDelta);
    }
    function up(): void {
      setDragging(false);
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousSelect;
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      onDragEnd?.(lastDelta);
    }
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  }

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      className={cn(
        "absolute inset-y-0 z-10 w-1 cursor-col-resize transition-colors",
        side === "right" ? "right-0" : "left-0",
        dragging ? "bg-ring/30" : "hover:bg-ring/20",
        className,
      )}
      onMouseDown={handleMouseDown}
    />
  );
}
