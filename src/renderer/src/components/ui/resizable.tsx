import { cn } from "cn"
import * as ResizablePrimitive from "react-resizable-panels"

/**
 * The three-column shell (sidebar | conversation | side pane) is laid out by
 * `react-resizable-panels` instead of a hand-rolled splitter.
 *
 * Why the library: the old handle listened for `mousemove`/`mouseup` on `window`,
 * which is the classic way to lose a drag. The side pane hosts an Electron
 * `<webview>`, and a pointer that crosses into the guest stops reaching the parent
 * document — so the drag froze mid-way and, worse, a button released over the guest
 * never fired `mouseup`, leaving the splitter welded to the cursor until the next
 * click. The library drives its separators with pointer events and
 * `setPointerCapture`, which keeps the events coming and always ends the drag, and
 * it brings keyboard resizing plus the separator ARIA values a `role="separator"`
 * div never had.
 *
 * The library owns only the *layout*: which column is how wide. Collapse state,
 * the resting width and the spring timing stay where they were (the side-pane and
 * sidebar stores, and `layout/collapsible-panel.tsx` for the narrow-viewport
 * drawer, which still uses it).
 */
function ResizablePanelGroup({
  className,
  ...props
}: ResizablePrimitive.GroupProps) {
  return (
    <ResizablePrimitive.Group
      data-slot="resizable-panel-group"
      className={cn("flex h-full w-full", className)}
      {...props}
    />
  )
}

function ResizablePanel({ className, style, ...props }: ResizablePrimitive.PanelProps) {
  return (
    <ResizablePrimitive.Panel
      data-slot="resizable-panel"
      /*
       * The library applies `className`/`style` to a nested div precisely so they
       * cannot fight the flex layout it writes on the panel itself. Making that box
       * a column flex container lets each pane's content fill it, and
       * `overflow: hidden` makes it the clipping ancestor the browser pane measures
       * its guest against (`side-pane-browser.tsx` → `clipAncestor`) — the panel
       * shrinks, so the guest follows it instead of painting over the conversation.
       */
      className={cn("flex min-h-0 min-w-0 flex-col", className)}
      style={{ overflow: "hidden", ...style }}
      {...props}
    />
  )
}

function ResizableHandle({
  className,
  ...props
}: ResizablePrimitive.SeparatorProps) {
  return (
    <ResizablePrimitive.Separator
      data-slot="resizable-handle"
      onKeyDownCapture={(event) => {
        /*
         * The library binds Home and End to "jump this panel to its extreme" and
         * Enter to "collapse it". All three end with the panel gone — and a panel
         * that is collapsed has no separator, so the element the keys were pressed
         * on unmounts and keyboard focus falls back to the document. The shell has
         * real toggle buttons for showing and hiding a pane, reachable by keyboard,
         * so the separator only resizes.
         *
         * Capture, not bubble: the library listens on the element itself, and it
         * bails out on an event that is already `defaultPrevented`.
         */
        if (event.key === "Home" || event.key === "End" || event.key === "Enter") event.preventDefault();
      }}
      className={cn(
        // A flex item now, not an overlay on top of a pane: the hairline can no
        // longer be painted over by a sticky gutter inside the pane it belongs to.
        // One pixel, not four: the old handle was absolute and painted over the
        // panel edge, so a 4px flex gap read as a thick stripe between columns.
        "relative z-20 w-px shrink-0 cursor-col-resize bg-transparent transition-colors",
        // A hairline is too narrow to grab. The pseudo-element widens the target
        // without taking layout space from either pane.
        "after:absolute after:inset-y-0 after:-left-1.5 after:-right-1.5 after:content-['']",
        "hover:bg-ring/25 data-[separator=active]:bg-ring/40 focus-visible:bg-ring/40",
        className
      )}
      {...props}
    />
  )
}

export { ResizableHandle, ResizablePanel, ResizablePanelGroup }
